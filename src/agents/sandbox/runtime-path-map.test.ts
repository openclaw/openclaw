import { describe, expect, it } from "vitest";
import {
  __loadRuntimePathMapEntriesFromDocumentForTests,
  collectTranslatedSandboxBindSourceRoots,
  isRuntimePathMapped,
  translateContainerPathToHostPath,
  translateSandboxBindSpecToHostPath,
  translateSandboxDockerConfigToHost,
} from "./runtime-path-map.js";

const ENTRIES = __loadRuntimePathMapEntriesFromDocumentForTests({
  container_host_roots: [
    { container: "/shared-workspace", host: "workspace" },
    { container: "/shared-files", host: "shared-files" },
    { container: "/agent-homes/tony", host: "workspace-tony" },
    { container: "/home/node/.openclaw", host: "." },
  ],
});

describe("runtime path map", () => {
  it("translates container-native workspace paths back to host bind sources", () => {
    expect(translateContainerPathToHostPath("/shared-workspace/projects/openclaw", ENTRIES)).toBe(
      "/Users/test/.openclaw/workspace/projects/openclaw",
    );
    expect(translateContainerPathToHostPath("/agent-homes/tony/memory/active", ENTRIES)).toBe(
      "/Users/test/.openclaw/workspace-tony/memory/active",
    );
    expect(translateContainerPathToHostPath("/shared-files/inbox", ENTRIES)).toBe(
      "/Users/test/.openclaw/shared-files/inbox",
    );
  });

  it("leaves unmatched absolute paths untouched", () => {
    expect(translateContainerPathToHostPath("/tmp/something", ENTRIES)).toBe("/tmp/something");
  });

  it("reports whether container-native paths are backed by the runtime path map", () => {
    expect(isRuntimePathMapped("/agent-homes/tony/subagents/research", ENTRIES)).toBe(true);
    expect(isRuntimePathMapped("/shared-files/inbox", ENTRIES)).toBe(true);
    expect(isRuntimePathMapped("/agent-homes/scout/subagents/research", ENTRIES)).toBe(false);
    expect(isRuntimePathMapped("/tmp/local-workspace", ENTRIES)).toBe(true);
  });

  it("translates sandbox bind specs using the mapped host source", () => {
    expect(
      translateSandboxBindSpecToHostPath("/shared-workspace:/shared-workspace:ro", ENTRIES),
    ).toBe("/Users/test/.openclaw/workspace:/shared-workspace:ro");
  });

  it("translates docker config bind arrays without mutating unrelated fields", () => {
    expect(
      translateSandboxDockerConfigToHost(
        {
          image: "openclaw-sandbox:tony",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: false,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          binds: ["/shared-workspace:/shared-workspace:ro"],
        },
        ENTRIES,
      ),
    ).toMatchObject({
      binds: ["/Users/test/.openclaw/workspace:/shared-workspace:ro"],
      image: "openclaw-sandbox:tony",
      workdir: "/workspace",
    });
  });

  it("translates docker config allowedSourceRoots entries", () => {
    expect(
      translateSandboxDockerConfigToHost(
        {
          image: "openclaw-sandbox:tony",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: false,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          allowedSourceRoots: ["/shared-workspace", "/shared-files", "/tmp/local-only"],
        },
        ENTRIES,
      ),
    ).toMatchObject({
      allowedSourceRoots: [
        "/Users/test/.openclaw/workspace",
        "/Users/test/.openclaw/shared-files",
        "/tmp/local-only",
      ],
    });
  });

  it("collects only runtime-mapped bind sources for sandbox allowlists", () => {
    expect(
      collectTranslatedSandboxBindSourceRoots(
        [
          "/shared-workspace:/shared-workspace:ro",
          "/shared-files:/shared-files:rw",
          "/agent-homes/tony:/agent:ro",
          "/opt/external:/data:rw",
        ],
        ENTRIES,
      ),
    ).toEqual([
      "/Users/test/.openclaw/workspace",
      "/Users/test/.openclaw/shared-files",
      "/Users/test/.openclaw/workspace-tony",
    ]);
  });
});
