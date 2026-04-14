import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineWhatsAppBundledChannelEntry,
  defineWhatsAppBundledChannelSetupEntry,
  whatsappAssembly,
} from "./assembly.js";

const tempDirs: string[] = [];
const builtDistRoot = path.resolve("dist", "extensions", "whatsapp");
const builtDistEntryPath = path.join(builtDistRoot, "index.js");
const hasBuiltDistOutput = fs.existsSync(builtDistEntryPath);

function createIsolatedAuthEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    HOME: rootDir,
    USERPROFILE: rootDir,
    XDG_CONFIG_HOME: path.join(rootDir, ".config"),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete (globalThis as { __openclawWhatsAppPackRuntime?: unknown }).__openclawWhatsAppPackRuntime;
});

describe("whatsapp packaged contract", () => {
  it("resolves packaged entry, setup, and runtime sidecars through the assembly contract", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-whatsapp-assembly-"));
    tempDirs.push(tempRoot);
    const pluginRoot = path.join(tempRoot, "dist", "extensions", "whatsapp");
    const tempAuthDir = path.join(tempRoot, "auth", "work");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(tempAuthDir, { recursive: true });
    fs.writeFileSync(path.join(tempAuthDir, "creds.json"), '{"me":{"id":"123@s.whatsapp.net"}}\n');

    const entryPath = path.join(pluginRoot, "index.js");
    const setupEntryPath = path.join(pluginRoot, "setup-entry.js");
    fs.writeFileSync(entryPath, "export default {};\n", "utf8");
    fs.writeFileSync(setupEntryPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "channel-plugin-api.js"),
      'export const whatsappPlugin = { id: "whatsapp" };\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "setup-plugin-api.js"),
      'export const whatsappSetupPlugin = { id: "whatsapp-setup" };\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "runtime-api.js"),
      [
        "export function setWhatsAppRuntime(runtime) {",
        "  globalThis.__openclawWhatsAppPackRuntime = runtime;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "auth-presence.js"),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "export function hasAnyWhatsAppAuth(cfg, env = process.env) {",
        "  const authDir = cfg?.channels?.whatsapp?.authDir ?? cfg?.channels?.whatsapp?.accounts?.work?.authDir ?? path.join(env.HOME ?? '', 'missing');",
        "  return fs.existsSync(path.join(authDir, 'creds.json'));",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const packagedEntry = defineWhatsAppBundledChannelEntry(pathToFileURL(entryPath).href);
    const packagedSetupEntry = defineWhatsAppBundledChannelSetupEntry(
      pathToFileURL(setupEntryPath).href,
    );
    const packagedAuthPresence = path.join(pluginRoot, "auth-presence.js");
    const runtime = { logger: "packaged-runtime" };

    expect(packagedEntry.loadChannelPlugin()).toEqual({ id: "whatsapp" });
    expect(packagedSetupEntry.loadSetupPlugin()).toEqual({ id: "whatsapp-setup" });
    packagedEntry.setChannelRuntime?.(runtime as never);
    expect(
      (globalThis as { __openclawWhatsAppPackRuntime?: unknown }).__openclawWhatsAppPackRuntime,
    ).toBe(runtime);
    return import(pathToFileURL(packagedAuthPresence).href).then((mod) => {
      expect(
        mod.hasAnyWhatsAppAuth(
          {
            channels: {
              whatsapp: {
                authDir: tempAuthDir,
              },
            },
          },
          createIsolatedAuthEnv(tempRoot),
        ),
      ).toBe(true);
      expect(
        mod.hasAnyWhatsAppAuth(
          {
            channels: {
              whatsapp: {
                defaultAccount: "work",
                accounts: {
                  work: {
                    authDir: tempAuthDir,
                  },
                },
              },
            },
          },
          createIsolatedAuthEnv(tempRoot),
        ),
      ).toBe(true);
    });
  });

  it.skipIf(!hasBuiltDistOutput)(
    "loads the real built WhatsApp packaged entry, setup, and runtime sidecars from dist output",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-whatsapp-built-"));
      tempDirs.push(tempRoot);
      const tempAuthDir = path.join(tempRoot, "auth", "work");
      fs.mkdirSync(tempAuthDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempAuthDir, "creds.json"),
        '{"me":{"id":"123@s.whatsapp.net"}}\n',
      );

      const entryPath = builtDistEntryPath;
      const setupEntryPath = path.join(builtDistRoot, "setup-entry.js");
      const runtimePath = path.join(builtDistRoot, "runtime-api.js");
      const lightRuntimePath = path.join(builtDistRoot, "light-runtime-api.js");
      const authPresencePath = path.join(builtDistRoot, "auth-presence.js");
      const cacheBust = `?built=${Date.now()}`;
      const builtEntry = (await import(`${pathToFileURL(entryPath).href}${cacheBust}`))
        .default as ReturnType<typeof defineWhatsAppBundledChannelEntry>;
      const builtSetupEntry = (await import(`${pathToFileURL(setupEntryPath).href}${cacheBust}`))
        .default as ReturnType<typeof defineWhatsAppBundledChannelSetupEntry>;
      const builtRuntime = await import(`${pathToFileURL(runtimePath).href}${cacheBust}`);
      const builtLightRuntime = await import(`${pathToFileURL(lightRuntimePath).href}${cacheBust}`);
      const builtAuthPresence = await import(`${pathToFileURL(authPresencePath).href}${cacheBust}`);
      const runtime = { logger: "built-runtime" };

      expect(builtEntry.id).toBe(whatsappAssembly.id);
      expect(builtEntry.loadChannelPlugin()).toHaveProperty("id", whatsappAssembly.id);
      expect(builtSetupEntry.loadSetupPlugin()).toHaveProperty("id", whatsappAssembly.id);
      builtEntry.setChannelRuntime?.(runtime as never);
      expect(builtRuntime).toHaveProperty("setWhatsAppRuntime");
      for (const exportName of whatsappAssembly.runtime.heavyExportNames) {
        expect(builtRuntime).toHaveProperty(exportName);
      }
      for (const exportName of whatsappAssembly.runtime.lightExportNames) {
        expect(builtLightRuntime).toHaveProperty(exportName);
      }
      expect(
        builtAuthPresence.hasAnyWhatsAppAuth(
          {
            channels: {
              whatsapp: {
                authDir: tempAuthDir,
              },
            },
          },
          createIsolatedAuthEnv(tempRoot),
        ),
      ).toBe(true);
      expect(
        builtAuthPresence.hasAnyWhatsAppAuth(
          {
            channels: {
              whatsapp: {
                defaultAccount: "work",
                accounts: {
                  work: {
                    authDir: tempAuthDir,
                  },
                },
              },
            },
          },
          createIsolatedAuthEnv(tempRoot),
        ),
      ).toBe(true);
    },
  );
});
