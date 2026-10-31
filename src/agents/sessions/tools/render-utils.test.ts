import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type Component, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../../modes/interactive/theme/theme.js";
import { readRenderContext as context } from "./read-render.test-support.js";
import { createReadToolDefinition } from "./read.js";

const theme = loadThemeFromPath(
  fileURLToPath(new URL("../../modes/interactive/theme/dark.json", import.meta.url)),
);
const tool = createReadToolDefinition("/workspace");

function renderCall(filePath: string, lastComponent?: Component) {
  return tool.renderCall?.({ path: filePath }, theme, context(filePath, lastComponent));
}

function visibleRows(component: Component | undefined, width = 120): string[] | undefined {
  return component?.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

describe("read tool rendering", () => {
  it("creates an unpadded Text slot and updates the same component on redraw", () => {
    const component = renderCall("hello");
    expect(component).toBeInstanceOf(Text);
    expect(visibleRows(component, 10)).toEqual(["read hello"]);

    const updated = renderCall("world", component);
    expect(updated).toBe(component);
    expect(visibleRows(updated, 10)).toEqual(["read world"]);
  });

  it.each([
    ["\n\n", []],
    ["alpha\n\n", ["", "alpha"]],
  ])("omits trailing blank result rows for %j", (text, rows) => {
    const component = tool.renderResult?.(
      { content: [{ type: "text", text }], details: { kind: "text", content: text } },
      { expanded: true, isPartial: false },
      theme,
      context("notes"),
    );
    expect(visibleRows(component)).toEqual(rows);
  });

  it("shortens paths inside the home directory", () => {
    expect(visibleRows(renderCall(`${os.homedir()}/projects/app.ts`))).toEqual([
      "read ~/projects/app.ts",
    ]);
  });

  it.skipIf(process.platform !== "win32")("shortens real Windows home casing aliases", () => {
    const homeAlias = os.homedir().toUpperCase();
    expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
    expect(visibleRows(renderCall(path.join(homeAlias, "projects", "app.ts")))).toEqual([
      `read ~${path.sep}projects${path.sep}app.ts`,
    ]);
  });

  it("shows the incomplete-path placeholder", () => {
    expect(visibleRows(renderCall(""))).toEqual(["read ..."]);
  });
});
