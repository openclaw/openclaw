import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
  type ControlUiFocusTarget,
} from "./focus.js";

const sessionKey = "agent:main:work";
const browserQuery = "sessionKey=agent%3Amain%3Awork&";
const browserLocation = (query: string, base = "") => ({
  pathname: `${base}/focus/browser`,
  search: `?${query}`,
});

describe("Control UI focus locations", () => {
  it.each<
    [
      Parameters<typeof parseControlUiFocusLocation>[0],
      string | undefined,
      ControlUiFocusTarget,
      string?,
    ]
  >([
    [
      browserLocation(
        `${browserQuery}target=host&profile=work.profile&targetId=tab%2F1`,
        "/openclaw",
      ),
      undefined,
      {
        kind: "browser",
        sessionKey,
        tab: { target: "host", profile: "work.profile", targetId: "tab/1" },
      },
      "/openclaw",
    ],
    [
      browserLocation(
        `${browserQuery}target=node&node=node%2Fone&profile=work&targetId=..`,
        "/openclaw",
      ),
      undefined,
      {
        kind: "browser",
        sessionKey,
        tab: { target: "node", node: "node/one", profile: "work", targetId: ".." },
      },
      "/openclaw",
    ],
    [
      "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
      undefined,
      {
        kind: "dashboard",
        route: { pathname: "/dashboard/roboclaw/the-daily-claw-6d7c9ccb", search: "", hash: "" },
      },
    ],
    [
      "/openclaw/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb/",
      "/openclaw",
      {
        kind: "dashboard",
        route: {
          pathname: "/openclaw/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
          search: "",
          hash: "",
        },
      },
    ],
    [
      {
        pathname: "/focus/dashboard/main",
        search: "?catalog=beam&host=gateway&thread=one",
        hash: "#pane",
      },
      undefined,
      {
        kind: "dashboard",
        route: {
          pathname: "/dashboard/main",
          search: "?catalog=beam&host=gateway&thread=one",
          hash: "#pane",
        },
      },
    ],
    ["/focus/terminal", "", { kind: "terminal" }],
    ["/focus/desktop/", "", { kind: "desktop", control: false, selector: null }],
    [
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
      "",
      {
        kind: "desktop",
        control: false,
        selector: { kind: "source", value: "environment:Mac Studio/QA & demo" },
      },
    ],
    ["/focus/desktop/control", "", { kind: "desktop", control: true, selector: null }],
    [
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
      "",
      { kind: "desktop", control: true, selector: { kind: "session", value: "agent:main:mobile" } },
    ],
  ])("parses %j", (input, basePath, target, expectedBase = basePath ?? "") => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual({
      status: "valid",
      basePath: expectedBase,
      target,
    });
  });

  it.each([
    ...[
      "",
      `${browserQuery}target=host&profile=work`,
      `${browserQuery}target=node&profile=work&targetId=one`,
      `${browserQuery}target=host&node=other&profile=work&targetId=one`,
      `${browserQuery}target=host&profile=work&targetId=one&targetId=two`,
      "sessionKey=%20&target=host&profile=work&targetId=one",
    ].map((query) => ({
      input: browserLocation(query),
      basePath: undefined,
      expected: { status: "unsupported", basePath: "" },
    })),
    ...[
      "/focus",
      "/focus/desktop/source",
      "/focus/desktop/session/%",
      "/focus/desktop/control/unknown/value",
    ].map((input) => ({ input, basePath: "", expected: { status: "unsupported", basePath: "" } })),
    ...["/?view=dashboard&session=agent%3Amain%3Awork", "/focused/terminal"].map((input) => ({
      input,
      basePath: "",
      expected: null,
    })),
  ])("rejects unsupported or unrelated location $input", ({ input, basePath, expected }) => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual(expected);
  });

  it("infers focus-aware base paths without overriding an explicit base", () => {
    expect(inferControlUiFocusBasePath("/focus/terminal")).toBe("");
    expect(inferControlUiFocusBasePath("/openclaw/focus/desktop")).toBe("/openclaw");
    expect(inferControlUiFocusBasePath("/company/focus/focus/terminal")).toBe("/company/focus");
    expect(inferControlUiFocusBasePath("/focused/terminal")).toBeNull();
    expect(parseControlUiFocusLocation("/openclaw/focus/terminal", "/other")).toBeNull();
  });

  it.each([
    [
      "browser query selectors",
      {
        kind: "browser",
        sessionKey,
        tab: { target: "node", node: "worker/a", profile: "work", targetId: ".." },
      },
      "/openclaw",
      "/openclaw/focus/browser?sessionKey=agent%3Amain%3Awork&target=node&profile=work&targetId=..&node=worker%2Fa",
    ],
    [
      "dashboard",
      { kind: "dashboard", path: "/dashboard/roboclaw/the-daily-claw-6d7c9ccb" },
      "",
      "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
    [
      "base-path dashboard with suffix",
      { kind: "dashboard", path: "/openclaw/dashboard/roboclaw/main?catalog=beam#pane" },
      "/openclaw/",
      "/openclaw/focus/dashboard/roboclaw/main?catalog=beam#pane",
    ],
    ["terminal", { kind: "terminal" }, "/openclaw", "/openclaw/focus/terminal"],
    ["desktop", { kind: "desktop" }, "", "/focus/desktop"],
    [
      "desktop source",
      { kind: "desktop", source: "environment:Mac Studio/QA & demo" },
      "",
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
    ],
    [
      "desktop session",
      { kind: "desktop", session: "agent:main:mobile session" },
      "",
      "/focus/desktop/session/agent%3Amain%3Amobile%20session",
    ],
    [
      "controlled source wins",
      { kind: "desktop", control: true, source: "node:worker-1", session: "agent:main:mobile" },
      "",
      "/focus/desktop/control/source/node%3Aworker-1",
    ],
    [
      "empty values",
      { kind: "desktop", source: " ", session: "" },
      "/openclaw",
      "/openclaw/focus/desktop",
    ],
    [
      "dashboard outside configured base",
      { kind: "dashboard", path: "/dashboard/roboclaw/main" },
      "/openclaw",
      null,
    ],
  ] as const)("builds %s", (_name, target, basePath, expected) => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(expected);
  });
});
