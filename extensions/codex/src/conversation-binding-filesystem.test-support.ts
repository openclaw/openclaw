import type { ReadFileSyncOptions } from "node:fs";
import { vi } from "vitest";

export async function mockRequirementsFs(readRequirements: () => string | undefined) {
  const actual = await vi.importActual<
    typeof import("node:fs") & { default: typeof import("node:fs") }
  >("node:fs");
  const overrides = {
    readFileSync(
      filePath: string | URL | number,
      options?: BufferEncoding | ReadFileSyncOptions | null,
    ) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = readRequirements();
        if (content !== undefined) {
          return content;
        }
        throw Object.assign(new Error("Synthetic Codex requirements file is absent"), {
          code: "ENOENT",
        });
      }
      return actual.readFileSync(
        filePath,
        typeof options === "string" ? { encoding: options } : (options ?? {}),
      );
    },
  };
  return { ...actual, ...overrides, default: { ...actual.default, ...overrides } };
}
