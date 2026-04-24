import { describe, expect, it, vi } from "vitest";
import { warnIfAddOnPrincipalLooksWrong } from "./monitor.js";

describe("warnIfAddOnPrincipalLooksWrong (startup diagnostics for #71078)", () => {
  it("warns when audienceType=app-url and appPrincipal is missing", () => {
    const warn = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "default",
      audienceType: "app-url",
      appPrincipal: undefined,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("[default]");
    expect(message).toContain("appPrincipal is unset");
    expect(message).toContain("numeric OAuth 2.0 client id");
  });

  it("warns when audienceType=app-url and appPrincipal is empty/whitespace", () => {
    const warn = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "default",
      audienceType: "app-url",
      appPrincipal: "   ",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as [string])[0]).toContain("appPrincipal is unset");
  });

  it("warns when audienceType=app-url and appPrincipal is email-shaped", () => {
    const warn = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "acct-1",
      audienceType: "app-url",
      appPrincipal: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("[acct-1]");
    expect(message).toContain("email-shaped");
    expect(message).toContain("numeric OAuth 2.0 client id");
  });

  it("is silent when audienceType=app-url and appPrincipal is a plausible numeric id", () => {
    const warn = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "default",
      audienceType: "app-url",
      appPrincipal: "123456789012345678901",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent for non-app-url audience types", () => {
    const warn = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "default",
      audienceType: "project-number",
      appPrincipal: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { warn },
      accountId: "default",
      audienceType: undefined,
      appPrincipal: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to runtime.log when runtime.warn is not provided", () => {
    const log = vi.fn();
    warnIfAddOnPrincipalLooksWrong({
      runtime: { log },
      accountId: "default",
      audienceType: "app-url",
      appPrincipal: "",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect((log.mock.calls[0] as [string])[0]).toContain("appPrincipal is unset");
  });

  it("is a no-op when the runtime exposes no log sinks", () => {
    expect(() =>
      warnIfAddOnPrincipalLooksWrong({
        runtime: {},
        accountId: "default",
        audienceType: "app-url",
        appPrincipal: undefined,
      }),
    ).not.toThrow();
  });
});
