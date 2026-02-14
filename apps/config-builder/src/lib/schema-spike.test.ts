import { describe, expect, it } from "vitest";
import { buildExplorerSnapshot, resolveExplorerField } from "./schema-spike.ts";

describe("buildExplorerSnapshot", () => {
  it("builds ordered sections and field metadata", () => {
    const snapshot = buildExplorerSnapshot();

    expect(snapshot.sectionCount).toBeGreaterThan(0);
    expect(snapshot.fieldCount).toBeGreaterThan(0);
    expect(snapshot.sections[0]?.order).toBeLessThanOrEqual(snapshot.sections.at(-1)?.order ?? 0);

    const gatewaySection = snapshot.sections.find((section) => section.id === "gateway");
    expect(gatewaySection).toBeTruthy();
    expect(gatewaySection?.fields.some((field) => field.path === "gateway.auth.token")).toBe(true);

    const tokenField = gatewaySection?.fields.find((field) => field.path === "gateway.auth.token");
    expect(tokenField?.sensitive).toBe(true);
    expect(tokenField?.kind).toBe("string");
    expect(tokenField?.editable).toBe(true);

    const wildcardField = snapshot.sections
      .flatMap((section) => section.fields)
      .find((field) => field.path.includes("*"));
    expect(wildcardField?.editable).toBe(false);

    const telegramToken = snapshot.sections
      .flatMap((section) => section.fields)
      .find((field) => field.path === "channels.telegram.botToken");
    expect(telegramToken?.kind).toBe("string");

    const updateChannel = snapshot.sections
      .flatMap((section) => section.fields)
      .find((field) => field.path === "update.channel");
    expect(updateChannel?.kind).toBe("enum");
    expect(updateChannel?.enumValues).toContain("stable");

    const arrayField = snapshot.sections
      .flatMap((section) => section.fields)
      .find((field) => field.path === "tools.alsoAllow");
    expect(arrayField?.kind).toBe("array");
    expect(arrayField?.itemKind).toBe("string");

    const recordField = snapshot.sections
      .flatMap((section) => section.fields)
      .find((field) => field.path === "diagnostics.otel.headers");
    expect(recordField?.kind).toBe("object");
    expect(recordField?.recordValueKind).toBe("string");

    const browserFields = snapshot.sections
      .find((section) => section.id === "browser")
      ?.fields.map((field) => field.path) ?? [];
    expect(browserFields.includes("browser.snapshotDefaults.mode")).toBe(true);
    expect(browserFields.includes("browser.snapshotDefaults")).toBe(false);
  });
});

describe("resolveExplorerField", () => {
  it("resolves metadata for paths that do not have explicit UI hints", () => {
    const port = resolveExplorerField("gateway.port");
    expect(port).toBeTruthy();
    expect(port?.kind).toBe("integer");
    expect(port?.editable).toBe(true);
  });

  it("returns null for unknown paths", () => {
    expect(resolveExplorerField("this.path.does.not.exist")).toBeNull();
  });

  it("drops hint-only paths that are not in the schema", () => {
    expect(resolveExplorerField("tools.web.fetch.firecrawl.enabled")).toBeNull();
  });
});
