import { describe, expect, it } from "vitest";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import { buildBootstrapContextFiles } from "./bootstrap.js";

describe("buildBootstrapContextFiles privacy tags", () => {
  it("strips content between OWNER_ONLY tags when senderIsOwner is false", () => {
    const files: Partial<WorkspaceBootstrapFile>[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: "/path/to/USER.md",
        content:
          "Public header\n<!-- OWNER_ONLY -->Private info<!-- /OWNER_ONLY -->\nPublic footer",
        missing: false,
      },
    ];

    const result = buildBootstrapContextFiles(files as WorkspaceBootstrapFile[], {
      senderIsOwner: false,
    });
    expect(result[0].content).toContain("Public header");
    expect(result[0].content).toContain("[Content restricted to owner]");
    expect(result[0].content).toContain("Public footer");
    expect(result[0].content).not.toContain("Private info");
  });

  it("preserves content between OWNER_ONLY tags when senderIsOwner is true", () => {
    const files: Partial<WorkspaceBootstrapFile>[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: "/path/to/USER.md",
        content:
          "Public header\n<!-- OWNER_ONLY -->Private info<!-- /OWNER_ONLY -->\nPublic footer",
        missing: false,
      },
    ];

    const result = buildBootstrapContextFiles(files as WorkspaceBootstrapFile[], {
      senderIsOwner: true,
    });
    expect(result[0].content).toContain("Private info");
    expect(result[0].content).toContain("<!-- OWNER_ONLY -->");
  });

  it("strips to end of content when closing tag is missing", () => {
    const files: Partial<WorkspaceBootstrapFile>[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: "/path/to/USER.md",
        content: "Public header\n<!-- OWNER_ONLY -->Secret without closing tag\nMore secret",
        missing: false,
      },
    ];

    const result = buildBootstrapContextFiles(files as WorkspaceBootstrapFile[], {
      senderIsOwner: false,
    });
    expect(result[0].content).toBe("Public header\n[Content restricted to owner]");
    expect(result[0].content).not.toContain("Secret without closing tag");
    expect(result[0].content).not.toContain("More secret");
  });

  it("handles multiple tags in one file", () => {
    const files: Partial<WorkspaceBootstrapFile>[] = [
      {
        name: "USER.md" as WorkspaceBootstrapFile["name"],
        path: "/path/to/USER.md",
        content:
          "Part 1<!-- OWNER_ONLY -->Secret 1<!-- /OWNER_ONLY -->Part 2<!-- OWNER_ONLY -->Secret 2<!-- /OWNER_ONLY -->Part 3",
        missing: false,
      },
    ];

    const result = buildBootstrapContextFiles(files as WorkspaceBootstrapFile[], {
      senderIsOwner: false,
    });
    expect(result[0].content).toBe(
      "Part 1[Content restricted to owner]Part 2[Content restricted to owner]Part 3",
    );
  });
});
