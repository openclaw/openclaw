import path from "node:path";
import { expect, it } from "vitest";
import {
  isBootstrapMissingContextFile,
  markBootstrapMissingContextFile,
} from "../../embedded-agent-helpers/bootstrap.js";
import { remapInjectedContextFilesToWorkspace } from "./attempt-setup.js";

it("remaps workspace context paths while preserving outside references", () => {
  const files = [
    { path: "/real/workspace/AGENTS.md", content: "agents" },
    { path: "/real/workspace/nested/SOUL.md", content: "soul" },
    { path: "/real/workspace/..context/USER.md", content: "dot-prefixed context" },
    { path: "/outside/README.md", content: "outside" },
  ];
  expect(
    remapInjectedContextFilesToWorkspace({
      files,
      sourceWorkspaceDir: "/real/workspace",
      targetWorkspaceDir: "/sandbox/workspace",
    }),
  ).toEqual([
    { path: path.join("/sandbox/workspace", "AGENTS.md"), content: "agents" },
    { path: path.join("/sandbox/workspace", "nested/SOUL.md"), content: "soul" },
    { path: path.join("/sandbox/workspace", "..context/USER.md"), content: "dot-prefixed context" },
    files[3],
  ]);
});

it("preserves missing-file provenance across workspace remapping", () => {
  const missingFile = markBootstrapMissingContextFile({
    path: "/real/workspace/BOOTSTRAP.md",
    content: "[MISSING] Expected at: /real/workspace/BOOTSTRAP.md",
  });
  const normalFile = {
    path: "/real/workspace/AGENTS.md",
    content: "agents",
  };
  const remapped = remapInjectedContextFilesToWorkspace({
    files: [missingFile, normalFile],
    sourceWorkspaceDir: "/real/workspace",
    targetWorkspaceDir: "/sandbox/workspace",
  });
  expect(isBootstrapMissingContextFile(remapped[0]!)).toBe(true);
  expect(isBootstrapMissingContextFile(remapped[1]!)).toBe(false);
  expect(Object.keys(remapped[0]!)).toEqual(["path", "content"]);
});
