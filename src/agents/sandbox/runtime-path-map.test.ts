import { describe, expect, it } from "vitest";
import {
  __loadRuntimePathMapEntriesFromDocumentForTests,
  collectTranslatedSandboxBindSourceRoots,
  translateContainerPathToHostPath,
  translateSandboxBindSpecToHostPath,
  translateSandboxDockerConfigToHost,
} from "./runtime-path-map.js";

const ENTRIES = __loadRuntimePathMapEntriesFromDocumentForTests({
  container_host_roots: [
    { container: "/shared-workspace", host: "/Users/franco/.openclaw/workspace" },
    { container: "/agent-homes/tony", host: "/Users/franco/.openclaw/workspace-tony" },
    { container: "/home/node/.openclaw", host: "/Users/franco/.openclaw" },
  ],
});

describe("runtime path map", () => {
  it("translates container-native workspace paths back to host bind sources", () => {
    expect(translateContainerPathToHostPath("/shared-workspace/projects/openclaw", ENTRIES)).toBe(
      "/Users/franco/.openclaw/workspace/projects/openclaw",
    );
    expect(translateContainerPathToHostPath("/agent-homes/tony/memory/active", ENTRIES)).toBe(
      "/Users/franco/.openclaw/workspace-tony/memory/active",
    );
  });

  it("leaves unmatched absolute paths untouched", () => {
    expect(translateContainerPathToHostPath("/tmp/something", ENTRIES)).toBe("/tmp/something");
  });

  it("translates sandbox bind specs using the mapped host source", () => {
    expect(
      translateSandboxBindSpecToHostPath("/shared-workspace:/shared-workspace:ro", ENTRIES),
    ).toBe("/Users/franco/.openclaw/workspace:/shared-workspace:ro");
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
      binds: ["/Users/franco/.openclaw/workspace:/shared-workspace:ro"],
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
          allowedSourceRoots: ["/shared-workspace", "/tmp/local-only"],
        },
        ENTRIES,
      ),
    ).toMatchObject({
      allowedSourceRoots: ["/Users/franco/.openclaw/workspace", "/tmp/local-only"],
    });
  });

  it("collects only runtime-mapped bind sources for sandbox allowlists", () => {
    expect(
      collectTranslatedSandboxBindSourceRoots(
        [
          "/shared-workspace:/shared-workspace:ro",
          "/agent-homes/tony:/agent:ro",
          "/opt/external:/data:rw",
        ],
        ENTRIES,
      ),
    ).toEqual(["/Users/franco/.openclaw/workspace", "/Users/franco/.openclaw/workspace-tony"]);
  });
});
