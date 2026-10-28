import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertManagedGitLabExecHost,
  prepareExecIdentityEnvironment,
} from "./exec-identity-environment.js";

const config = {
  tools: {
    github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    gitlab: {
      profileId: "glp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      issuer: "https://gitlab.example.test",
    },
  },
} as OpenClawConfig;

it("combines selected GitHub and GitLab profiles without changing GitHub's managed flag", () => {
  const prepared = prepareExecIdentityEnvironment({ config, agentId: "main" });
  expect(prepared.managedLocalIdentity).toBe(true);
  expect(prepared.managedGitLabIdentity).toBe(true);
  expect(prepared.hostExecutionRequired).toBe(true);
  expect(prepared.localIdentityEnv.GH_CONFIG_DIR).toContain("/github/");
  expect(prepared.localIdentityEnv.GLAB_CONFIG_DIR).toContain("/gitlab/");
  expect(prepared.localIdentityEnv.GITLAB_HOST).toBe("gitlab.example.test");
  expect(prepared.credentialScrubEnv.GH_TOKEN).toBe("");
  expect(prepared.credentialScrubEnv.GITLAB_TOKEN).toBe("");
  expect(prepared.credentialScrubEnv.GL_HOST).toBe("");
  expect(prepared.credentialScrubEnv.GLAB_API_PROTOCOL).toBe("https");
  expect(JSON.stringify(prepared)).not.toContain("synthetic-selected");
});

it("preserves native GitHub behavior when only GitLab is selected", () => {
  const prepared = prepareExecIdentityEnvironment({
    config: { tools: { gitlab: config.tools!.gitlab } },
    agentId: "main",
  });
  expect(prepared.managedLocalIdentity).toBe(false);
  expect(prepared.managedGitLabIdentity).toBe(true);
  expect(prepared.localIdentityEnv.GH_CONFIG_DIR).toBeUndefined();
});

it("denies selected GitLab execution on a node or a sandbox without a private profile mount", () => {
  expect(() => assertManagedGitLabExecHost({ selected: true, host: "node" })).toThrow(
    "requires local execution",
  );
  expect(() => assertManagedGitLabExecHost({ selected: true, host: "sandbox" })).toThrow(
    "isolated sandbox",
  );
  expect(() =>
    assertManagedGitLabExecHost({
      selected: true,
      host: "sandbox",
      sandboxProfileDir: "/private/profile",
    }),
  ).not.toThrow();
});
