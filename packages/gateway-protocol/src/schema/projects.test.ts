import { describe, it } from "vitest";
import {
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  ProjectRecordSchema,
  ProjectsAddResultSchema,
  ProjectSummarySchema,
  ProjectsListResultSchema,
  ProjectsSearchRemoteResultSchema,
  validateProjectsAddParams as add,
  validateProjectsListParams as list,
  validateProjectsCheckoutOptionsParams as checkout,
  validateProjectsRegisterParams as register,
  validateProjectsRemoveParams as remove,
  validateProjectsSearchRemoteParams as search,
  validateSessionsCreateParams as createSession,
} from "../index.js";
import { check, copies, schemaValidation } from "./protocol-validation.test-support.js";

const gitUrl = "https://github.com/openclaw/openclaw.git";
const project = {
  id: "openclaw",
  displayName: "OpenClaw",
  repoRoot: "/repo/openclaw",
  originUrl: gitUrl,
  source: "registered",
};
const listResult = schemaValidation(ProjectsListResultSchema);
const summary = schemaValidation(ProjectSummarySchema);

describe("project protocol schemas", () => {
  it("validates closed project method inputs", () => {
    check(
      checkout,
      [{ projectId: "project", agentId: "main" }],
      [{ projectId: "project" }, { projectId: "project", agentId: "main", cwd: "/private" }],
    );
    check(
      list,
      [{}, { includeObserved: true }, { includeObserved: false }],
      [{ includeObserved: "yes" }, { extra: true }],
    );
    check(register, [{ path: "/repo", name: "OpenClaw" }], [{ path: "" }]);
    check(add, [{ gitUrl }], [{ gitUrl: "", unexpected: true }]);
    check(search, [{ query: "openclaw" }], [{ query: "" }]);
    check(remove, [{ id: "openclaw-2", deleteCheckout: true }], [{ id: "workspace:main" }]);
  });
  it("accepts bounded remote search and clone results", () => {
    schemaValidation(ProjectsAddResultSchema).accepts({ ...project, source: "cloned" });
    schemaValidation(ProjectsSearchRemoteResultSchema).accepts({
      credential: "missing",
      projects: [
        {
          name: "openclaw",
          fullName: "openclaw/openclaw",
          description: "Personal AI assistant",
          cloneUrl: gitUrl,
          webUrl: "https://github.com/openclaw/openclaw",
          defaultBranch: "main",
          private: false,
        },
      ],
    });
  });
  it("accepts workspace and stored project records", () => {
    schemaValidation(ProjectRecordSchema).accepts({
      id: "workspace:main",
      displayName: "openclaw",
      source: "workspace",
      agentId: "main",
    });
    listResult.accepts({ projects: [] });
    listResult.accepts({
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
    listResult.rejects({ observedProjects: [] });
  });
  it("bounds observed projects and checkout lists", () => {
    const observed = {
      name: "openclaw",
      originUrl: gitUrl,
      checkouts: [{ runnerId: "gateway", path: "/repo/openclaw" }],
      lastUsedAt: 1,
    };
    summary.accepts(observed);
    const checkouts = copies(observed.checkouts[0], PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1);
    summary.rejects({ ...observed, checkouts });
    const observedProjects = copies(observed, PROJECTS_LIST_DEFAULT_LIMIT + 1);
    listResult.rejects({ projects: [], observedProjects });
  });
  it("bounds additive session project IDs and remote URLs", () => {
    check(
      createSession,
      [
        { agentId: "main", projectId: "openclaw" },
        { agentId: "main", projectGitUrl: gitUrl },
      ],
      [
        { agentId: "main", projectId: "" },
        { agentId: "main", projectGitUrl: "" },
        { agentId: "main", projectGitUrl: "x".repeat(2_049) },
      ],
    );
  });
});
