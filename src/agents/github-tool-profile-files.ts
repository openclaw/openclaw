import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { stringify as stringifyYaml } from "yaml";
import { managedGitHubHosts } from "./github-tool-account.js";
import { notifyManagedGitHubProfileChanged } from "./github-tool-identity-lifecycle.js";

/** Write gh's external file contract without touching its OS keyring or verifying again. */
export async function writeManagedGitHubProfileFiles(
  profileDir: string,
  identity: { login: string; token: string },
  options?: { assertCurrent: () => void },
): Promise<void> {
  if (process.platform === "win32") {
    // Worker profiles live under OS temp, outside the node's restricted state ACL.
    const parentDir = path.dirname(profileDir);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    const parent = await fsRoot(parentDir);
    await parent.mkdir(path.basename(profileDir), {
      private: true,
      assertBeforeMutation: options?.assertCurrent,
    });
  } else {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.chmod(profileDir, 0o700);
  }
  const profile = await fsRoot(profileDir, { mode: 0o600, mkdir: false, durable: false });
  await profile.write("config.yml", stringifyYaml({ version: "1" }));
  await profile.write("hosts.yml", managedGitHubHosts(identity), {
    assertBeforeMutation: options?.assertCurrent,
  });
  notifyManagedGitHubProfileChanged({ profileDir, kind: "updated" });
}
