import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  ProjectRecordSchema,
  ProjectsAddResultSchema,
  ProjectSummarySchema,
  ProjectsListResultSchema,
  ProjectsSearchRemoteResultSchema,
  validateProjectsAddParams,
  validateProjectsListParams,
  validateProjectsCheckoutOptionsParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateProjectsSearchRemoteParams,
  validateSessionsCreateParams,
} from "../index.js";

function check(schema: TSchema, value: unknown, valid = true) {
  expect(Value.Check(schema, value)).toBe(valid);
}
const project = {
  id: "openclaw",
  displayName: "OpenClaw",
  repoRoot: "/repo/openclaw",
  originUrl: "https://github.com/openclaw/openclaw.git",
  source: "registered",
};

describe("project protocol schemas", () => {
  it("validates project method inputs as closed objects", () => {
    expect(validateProjectsCheckoutOptionsParams({ projectId: "project", agentId: "main" })).toBe(
      true,
    );
    expect(validateProjectsCheckoutOptionsParams({ projectId: "project" })).toBe(false);
    const withCwd = { projectId: "project", agentId: "main", cwd: "/private" };
    expect(validateProjectsCheckoutOptionsParams(withCwd)).toBe(false);
    expect(validateProjectsListParams({})).toBe(true);
    expect(validateProjectsListParams({ includeObserved: true })).toBe(true);
    expect(validateProjectsListParams({ includeObserved: false })).toBe(true);
    expect(validateProjectsListParams({ includeObserved: "yes" })).toBe(false);
    expect(validateProjectsListParams({ extra: true })).toBe(false);
    expect(validateProjectsRegisterParams({ path: "/repo", name: "OpenClaw" })).toBe(true);
    expect(validateProjectsRegisterParams({ path: "" })).toBe(false);
    expect(validateProjectsAddParams({ gitUrl: project.originUrl })).toBe(true);
    expect(validateProjectsAddParams({ gitUrl: "", unexpected: true })).toBe(false);
    expect(validateProjectsSearchRemoteParams({ query: "openclaw" })).toBe(true);
    expect(validateProjectsSearchRemoteParams({ query: "" })).toBe(false);
    expect(validateProjectsRemoveParams({ id: "openclaw-2", deleteCheckout: true })).toBe(true);
    expect(validateProjectsRemoveParams({ id: "workspace:main" })).toBe(false);
  });

  it("accepts bounded remote search and clone results", () => {
    check(ProjectsAddResultSchema, { ...project, source: "cloned" });
    check(ProjectsSearchRemoteResultSchema, {
      credential: "missing",
      projects: [
        {
          name: "openclaw",
          fullName: "openclaw/openclaw",
          description: "Personal AI assistant",
          cloneUrl: "https://github.com/openclaw/openclaw.git",
          webUrl: "https://github.com/openclaw/openclaw",
          defaultBranch: "main",
          private: false,
        },
      ],
    });
  });

  it("accepts workspace and stored project records", () => {
    check(ProjectRecordSchema, {
      id: "workspace:main",
      displayName: "openclaw",
      source: "workspace",
      agentId: "main",
    });
    check(ProjectsListResultSchema, {
      projects: [project],
      defaultRepository: {
        identity: "acme/private-repo",
        url: "https://ghe.example.test/acme/private-repo.git",
        ref: "main",
        profileId: "example-azure",
      },
      recents: [
        { kind: "project", projectId: "openclaw", displayName: "OpenClaw" },
        { kind: "folder", folder: "/repo/scratch", displayName: "scratch" },
      ],
      observedProjects: [],
    });
    check(ProjectsListResultSchema, { projects: [] });
    check(ProjectsListResultSchema, { observedProjects: [] }, false);
  });

  it("bounds observed projects and their checkout lists", () => {
    const observedProject = {
      name: "openclaw",
      originUrl: "https://github.com/openclaw/openclaw.git",
      checkouts: [{ runnerId: "gateway", path: "/repo/openclaw" }],
      lastUsedAt: 1,
    };
    check(ProjectSummarySchema, observedProject);
    check(
      ProjectSummarySchema,
      {
        ...observedProject,
        checkouts: Array.from(
          { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1 },
          (_, index) => ({ runnerId: "gateway", path: `/repo/openclaw-${index}` }),
        ),
      },
      false,
    );
    check(
      ProjectsListResultSchema,
      {
        projects: [],
        observedProjects: Array.from(
          { length: PROJECTS_LIST_DEFAULT_LIMIT + 1 },
          () => observedProject,
        ),
      },
      false,
    );
  });

  it("accepts bounded project identity and remote URL as additive sessions.create parameters", () => {
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "openclaw" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "" })).toBe(false);
    expect(
      validateSessionsCreateParams({ agentId: "main", projectGitUrl: project.originUrl }),
    ).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectGitUrl: "" })).toBe(false);
    expect(
      validateSessionsCreateParams({ agentId: "main", projectGitUrl: "x".repeat(2_049) }),
    ).toBe(false);
  });
});
