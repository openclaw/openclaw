import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Resolve the OpenClaw state-dir root for caching the MITM CA + leaf keys.
//
// PREFERRED PATH: the parent gateway (cli-backend-interactive.ts:normalizeConfig)
// runs the canonical resolveConfigDir() — which honours OPENCLAW_STATE_DIR,
// OPENCLAW_CONFIG_PATH, OPENCLAW_HOME/effective-home AND relative state-dir
// resolution — and hands us the FINAL absolute path via
// OPENCLAW_INTERACTIVE_PROXY_STATE_DIR. We use it verbatim so isolated profiles
// keep separate CA + private keys instead of sharing one set.
//
// FALLBACK PATH: when that env var is absent (standalone runs / tests), mirror
// resolveConfigDir inline as best we can without importing from src/ (this
// module runs in the bun-spawned wrapper child, which can't bundle src/). The
// inline mirror necessarily covers only the absolute/`~` OPENCLAW_STATE_DIR
// case and the homedir()/.openclaw default; the richer cases are handled by the
// preferred path above.
//
// Stored under the state dir rather than tmpdir() for stability — tmpdir
// contents can be wiped on macOS between reboots, causing unnecessary cert
// regen. The directory is user-private by OS default (700 on Unix, user-ACL on
// Windows).
export function resolveInteractiveProxyStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = env.OPENCLAW_INTERACTIVE_PROXY_STATE_DIR?.trim();
  if (resolved && isAbsolute(resolved)) {
    return resolved;
  }
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override === "~" || override.startsWith("~/") || override.startsWith("~\\")) {
      const tail = override === "~" ? "" : override.slice(2);
      return tail ? join(homedir(), tail) : homedir();
    }
    if (isAbsolute(override)) {
      return override;
    }
  }
  return join(homedir(), ".openclaw");
}

const CERT_DIR = join(resolveInteractiveProxyStateDir(), "proxy-certs");

// CA lifetime matches the leaf (365 days) so both expire together and the
// expiry check below forces a clean regen when either rolls over.
const CERT_DAYS = "365";

export type CertPaths = {
  caPath: string;
  caKeyPath: string;
  leafCertPath: string;
  leafKeyPath: string;
};

function findOpenssl(): string {
  const candidates = [
    "openssl",
    "/usr/bin/openssl",
    "/usr/local/bin/openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "pipe" });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error(
    "openssl not found. Install OpenSSL or Git for Windows to use the interactive proxy.",
  );
}

function runOpenssl(bin: string, args: string[]): void {
  // MSYS_NO_PATHCONV=1 prevents Git Bash from mangling absolute paths on Windows
  execFileSync(bin, args, {
    stdio: "pipe",
    env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
  });
}

function isCertValid(bin: string, certPath: string): boolean {
  try {
    execFileSync(bin, ["x509", "-noout", "-checkend", "0", "-in", certPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function allCertsValid(
  openssl: string,
  caPath: string,
  caKeyPath: string,
  leafCertPath: string,
  leafKeyPath: string,
): boolean {
  return (
    existsSync(caPath) &&
    existsSync(caKeyPath) &&
    existsSync(leafCertPath) &&
    existsSync(leafKeyPath) &&
    isCertValid(openssl, caPath) &&
    isCertValid(openssl, leafCertPath)
  );
}

// Exclusive file lock so two wrapper processes starting simultaneously (e.g. first
// run or expiry) don't interleave cert generation and produce a mismatched CA/leaf
// pair. Uses O_EXCL atomic create as the mutex; stale locks (process died) are
// broken after a 15 s timeout.
function withCertLock<T>(fn: () => T): T {
  const lockPath = join(CERT_DIR, ".gen.lock");
  mkdirSync(CERT_DIR, { recursive: true });

  const deadline = Date.now() + 15_000;
  let fd = -1;
  while (fd < 0) {
    try {
      fd = openSync(lockPath, "wx"); // atomic O_EXCL — fails if lock exists
    } catch {
      if (Date.now() > deadline) {
        // Stale lock from a process that died — break it and re-acquire.
        try {
          unlinkSync(lockPath);
        } catch {}
        try {
          fd = openSync(lockPath, "wx");
        } catch {
          throw new Error("Failed to acquire cert generation lock after breaking stale lock");
        }
        break;
      }
      // Brief busy-wait: Atomics.wait works in the main thread on both Node and Bun.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }

  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

// Re-apply private-key permission hardening. Idempotent: no-op when
// permissions are already correct. Returns true on success, false if ANY
// key couldn't be locked down — the caller is expected to fail closed
// (remove the keys and regenerate) when this returns false, rather than
// continuing to trust a CA/leaf key with potentially-broad permissions.
function hardenKeyPermissions(caKeyPath: string, leafKeyPath: string): boolean {
  if (process.platform === "win32") {
    const user = process.env.USERNAME ?? process.env.USER ?? "";
    if (!user) {
      return false;
    }
    for (const keyPath of [caKeyPath, leafKeyPath]) {
      try {
        execFileSync("icacls", [keyPath, "/inheritance:r", "/grant:r", `${user}:F`], {
          stdio: "ignore",
        });
      } catch {
        return false;
      }
    }
    return true;
  }
  for (const keyPath of [caKeyPath, leafKeyPath]) {
    try {
      const mode = statSync(keyPath).mode & 0o777;
      if (mode !== 0o600) {
        chmodSync(keyPath, 0o600);
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function ensureCerts(): CertPaths {
  const caPath = join(CERT_DIR, "ca.crt");
  const caKeyPath = join(CERT_DIR, "ca.key");
  const leafCertPath = join(CERT_DIR, "leaf.crt");
  const leafKeyPath = join(CERT_DIR, "leaf.key");

  const openssl = findOpenssl();

  // Fast path: all four files exist and neither cert has expired — no lock needed.
  if (allCertsValid(openssl, caPath, caKeyPath, leafCertPath, leafKeyPath)) {
    // Re-harden permissions on every call: cached keys generated by a prior
    // revision (before ACL hardening shipped) or by a run where icacls/chmod
    // failed must be repaired before we trust them again. **Fail closed** —
    // if the lockdown fails the keys may still be readable by other local
    // users, so drop the cached files and fall through to regeneration
    // (which runs under the lock and re-applies hardening with the same
    // closed-failure semantics).
    if (hardenKeyPermissions(caKeyPath, leafKeyPath)) {
      return { caPath, caKeyPath, leafCertPath, leafKeyPath };
    }
    for (const p of [caPath, caKeyPath, leafCertPath, leafKeyPath]) {
      if (existsSync(p)) {
        try {
          rmSync(p);
        } catch {}
      }
    }
  }

  return withCertLock(() => {
    // Re-check inside lock: another process may have generated valid certs while
    // we were waiting.
    if (allCertsValid(openssl, caPath, caKeyPath, leafCertPath, leafKeyPath)) {
      return { caPath, caKeyPath, leafCertPath, leafKeyPath };
    }

    // Remove stale cert files before regenerating so there is never a window where
    // a new CA key is paired with an old leaf cert (or vice versa).
    for (const p of [caPath, caKeyPath, leafCertPath, leafKeyPath]) {
      if (existsSync(p)) {
        rmSync(p);
      }
    }

    // Create the cert directory with 0700 mode BEFORE any key material lands
    // on disk so the keys are inside a user-private directory from the moment
    // openssl writes them. Without this, mkdirSync uses the current umask
    // (typically 0755 on Unix) and `openssl genrsa -out ca.key …` writes the
    // key under the same default umask (typically 0644) — both world-readable
    // until hardenKeyPermissions() runs at the end of generation. That's a
    // race window during which another local user can copy the reusable MITM
    // CA private key.
    //
    // On a directory that already exists, mkdirSync(... { recursive: true })
    // does NOT change the existing mode, so we follow with an explicit
    // chmodSync to handle the case where the dir was created by an earlier
    // run that didn't harden it. fs.constants on Windows is a no-op so this
    // is safe cross-platform.
    mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    try {
      chmodSync(CERT_DIR, 0o700);
    } catch {}
    const csrPath = join(CERT_DIR, "leaf.csr");
    const extPath = join(CERT_DIR, "leaf.ext");

    // CA key + self-signed cert
    runOpenssl(openssl, ["genrsa", "-out", caKeyPath, "2048"]);
    runOpenssl(openssl, [
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      caKeyPath,
      "-sha256",
      "-days",
      CERT_DAYS,
      "-subj",
      "/CN=OpenClaw Proxy CA",
      "-out",
      caPath,
    ]);

    // Leaf key + CSR
    runOpenssl(openssl, ["genrsa", "-out", leafKeyPath, "2048"]);
    runOpenssl(openssl, [
      "req",
      "-new",
      "-key",
      leafKeyPath,
      "-subj",
      "/CN=api.anthropic.com",
      "-out",
      csrPath,
    ]);

    // SAN extension file
    writeFileSync(
      extPath,
      [
        "authorityKeyIdentifier=keyid,issuer",
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "subjectAltName=@alt_names",
        "",
        "[alt_names]",
        "DNS.1=api.anthropic.com",
      ].join("\n"),
    );

    runOpenssl(openssl, [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      leafCertPath,
      "-days",
      CERT_DAYS,
      "-sha256",
      "-extfile",
      extPath,
    ]);

    // Restrict private-key access (Unix chmod 0600 / Windows icacls grant to
    // current user only). **Fail closed** — if the freshly-generated keys
    // can't be locked down, remove them and throw rather than ship keys with
    // broader permissions. Caller (wrapper) emits a setup-error result.
    if (!hardenKeyPermissions(caKeyPath, leafKeyPath)) {
      for (const p of [caPath, caKeyPath, leafCertPath, leafKeyPath]) {
        if (existsSync(p)) {
          try {
            rmSync(p);
          } catch {}
        }
      }
      throw new Error(
        "failed to restrict permissions on generated CA/leaf private keys; refusing to ship reusable MITM signing keys with broader access",
      );
    }

    return { caPath, caKeyPath, leafCertPath, leafKeyPath };
  });
}
