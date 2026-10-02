import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
} from "./focus.js";

describe("Control UI focus locations", () => {
  it.each([
    {
      query: "sessionKey=agent%3Amain%3Awork&target=host&profile=work.profile&targetId=tab%2F1",
      tab: { target: "host", profile: "work.profile", targetId: "tab/1" },
    },
    {
      query: "sessionKey=agent%3Amain%3Awork&target=node&node=node%2Fone&profile=work&targetId=..",
      tab: { target: "node", node: "node/one", profile: "work", targetId: ".." },
    },
  ])(
    "preserves an exact browser address in a base-path document ($tab.target)",
    ({ query, tab }) => {
      expect(
        parseControlUiFocusLocation({ pathname: "/openclaw/focus/browser", search: `?${query}` }),
      ).toEqual({
        status: "valid",
        basePath: "/openclaw",
        target: { kind: "browser", sessionKey: "agent:main:work", tab },
      });
    },
  );

  it.each([
    "",
    "sessionKey=agent%3Amain%3Awork&target=host&profile=work",
    "sessionKey=agent%3Amain%3Awork&target=node&profile=work&targetId=one",
    "sessionKey=agent%3Amain%3Awork&target=host&node=other&profile=work&targetId=one",
    "sessionKey=agent%3Amain%3Awork&target=host&profile=work&targetId=one&targetId=two",
    "sessionKey=%20&target=host&profile=work&targetId=one",
  ])("rejects incomplete or ambiguous browser identities (%s)", (query) => {
    expect(
      parseControlUiFocusLocation({ pathname: "/focus/browser", search: `?${query}` }),
    ).toEqual({
      status: "unsupported",
      basePath: "",
    });
  });

  it.each([
    [
      "dashboard short reference",
      "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
      undefined,
      "/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
    [
      "base-path dashboard",
      "/openclaw/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb/",
      "/openclaw",
      "/openclaw/dashboard/roboclaw/the-daily-claw-6d7c9ccb",
    ],
  ])("parses %s through the underlying dashboard route", (_name, pathname, basePath, routePath) => {
    expect(parseControlUiFocusLocation(pathname, basePath)).toEqual({
      status: "valid",
      basePath: basePath ?? "",
      target: {
        kind: "dashboard",
        route: { pathname: routePath, search: "", hash: "" },
      },
    });
  });

  it.each([
    ["terminal", "/focus/terminal", { kind: "terminal" }],
    ["desktop", "/focus/desktop/", { kind: "desktop", control: false, selector: null }],
    [
      "desktop source",
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
      {
        kind: "desktop",
        control: false,
        selector: { kind: "source", value: "environment:Mac Studio/QA & demo" },
      },
    ],
    [
      "controlled desktop",
      "/focus/desktop/control",
      { kind: "desktop", control: true, selector: null },
    ],
    [
      "controlled session",
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
      {
        kind: "desktop",
        control: true,
        selector: { kind: "session", value: "agent:main:mobile" },
      },
    ],
  ] as const)("parses %s", (_name, pathname, target) => {
    expect(parseControlUiFocusLocation(pathname, "")).toEqual({
      status: "valid",
      basePath: "",
      target,
    });
  });

  it.each([
    "/focus",
    "/focus/desktop/source",
    "/focus/desktop/session/%",
    "/focus/desktop/control/unknown/value",
  ])("rejects malformed or unsupported target %s", (pathname) => {
    expect(parseControlUiFocusLocation(pathname, "")).toEqual({
      status: "unsupported",
      basePath: "",
    });
  });

  it.each(["/?view=dashboard&session=agent%3Amain%3Awork", "/focused/terminal"])(
    "does not parse query aliases or lookalike location %s",
    (pathname) => {
      expect(parseControlUiFocusLocation(pathname, "")).toBeNull();
    },
  );

  it("infers focus-aware base paths without overriding an explicit base", () => {
    expect(inferControlUiFocusBasePath("/focus/terminal")).toBe("");
    expect(inferControlUiFocusBasePath("/openclaw/focus/desktop")).toBe("/openclaw");
    expect(inferControlUiFocusBasePath("/company/focus/focus/terminal")).toBe("/company/focus");
    expect(inferControlUiFocusBasePath("/focused/terminal")).toBeNull();
    expect(parseControlUiFocusLocation("/openclaw/focus/terminal", "/other")).toBeNull();
  });

  it("passes dashboard search and hash through to the canonical route loader", () => {
    expect(
      parseControlUiFocusLocation({
        pathname: "/focus/dashboard/main",
        search: "?catalog=beam&host=gateway&thread=one",
        hash: "#pane",
      }),
    ).toEqual({
      status: "valid",
      basePath: "",
      target: {
        kind: "dashboard",
        route: {
          pathname: "/dashboard/main",
          search: "?catalog=beam&host=gateway&thread=one",
          hash: "#pane",
        },
      },
    });
  });
});

describe("buildControlUiFocusPath", () => {
  it("encodes browser selectors as query data, never a website URL or path segment", () => {
    expect(
      buildControlUiFocusPath(
        {
          kind: "browser",
          sessionKey: "agent:main:work",
          tab: { target: "node", node: "worker/a", profile: "work", targetId: ".." },
        },
        "/openclaw",
      ),
    ).toBe(
      "/openclaw/focus/browser?sessionKey=agent%3Amain%3Awork&target=node&profile=work&targetId=..&node=worker%2Fa",
    );
  });

  it.each([
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
      {
        kind: "desktop",
        control: true,
        source: "node:worker-1",
        session: "agent:main:mobile",
      },
      "",
      "/focus/desktop/control/source/node%3Aworker-1",
    ],
    [
      "empty values",
      { kind: "desktop", source: " ", session: "" },
      "/openclaw",
      "/openclaw/focus/desktop",
    ],
  ] as const)("builds %s", (_name, target, basePath, expected) => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(expected);
  });

  it("rejects a dashboard route outside the configured base path", () => {
    expect(
      buildControlUiFocusPath({ kind: "dashboard", path: "/dashboard/roboclaw/main" }, "/openclaw"),
    ).toBeNull();
  });
});
