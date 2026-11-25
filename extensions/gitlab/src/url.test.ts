import { describe, expect, it } from "vitest";
import { toRemoteProject } from "./search.js";
import { parseGitLabProjectUrl, resolveGitLabOrigin } from "./url.js";

const ORIGIN = "https://gitlab.com";

describe("GitLab repository URLs", () => {
  it("normalizes nested project URLs on the configured server", () => {
    expect(parseGitLabProjectUrl("https://gitlab.com/group/sub/project", ORIGIN)).toEqual({
      url: "https://gitlab.com/group/sub/project.git",
      name: "project",
      fullName: "group/sub/project",
    });
    expect(parseGitLabProjectUrl("https://gitlab.com/group/project.git/", ORIGIN)?.url).toBe(
      "https://gitlab.com/group/project.git",
    );
  });

  it.each([
    "https://github.com/group/project",
    "http://gitlab.com/group/project",
    "https://user:token@gitlab.com/group/project",
    "https://gitlab.com/group/project/-/tree/main",
    "https://gitlab.com/project",
    "https://gitlab.com/group/project?ref=main",
    "file:///tmp/project",
  ])("refuses %s", (value) => {
    expect(parseGitLabProjectUrl(value, ORIGIN)).toBeUndefined();
  });

  it("accepts only an HTTPS server origin as baseUrl", () => {
    expect(resolveGitLabOrigin(undefined)).toBe(ORIGIN);
    expect(resolveGitLabOrigin("https://gitlab.example.test/")).toBe("https://gitlab.example.test");
    for (const value of ["http://gitlab.example.test", "https://gitlab.example.test/sub"]) {
      expect(() => resolveGitLabOrigin(value)).toThrow("GitLab baseUrl must be an HTTPS");
    }
  });

  it("maps API projects into the admitted clone form and drops foreign hosts", () => {
    expect(
      toRemoteProject(
        {
          path: "project",
          path_with_namespace: "group/project",
          web_url: "https://gitlab.com/group/project",
          default_branch: "main",
          visibility: "public",
        },
        ORIGIN,
      ),
    ).toEqual({
      name: "project",
      fullName: "group/project",
      cloneUrl: "https://gitlab.com/group/project.git",
      webUrl: "https://gitlab.com/group/project",
      defaultBranch: "main",
      private: false,
    });
    expect(
      toRemoteProject(
        { path: "p", path_with_namespace: "g/p", web_url: "https://evil.example/g/p" },
        ORIGIN,
      ),
    ).toBeUndefined();
  });
});
