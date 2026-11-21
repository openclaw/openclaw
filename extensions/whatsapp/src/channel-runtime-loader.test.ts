// Whatsapp tests cover the source-safe channel runtime loading boundary.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDirectoryTreeStrictSync } from "openclaw/plugin-sdk/file-access-runtime";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import {
  loadWhatsAppChannelRuntime,
  readWhatsAppAccountLinkState,
} from "./channel-runtime-loader.js";

const runtimeLoads = vi.hoisted(() => ({
  order: [] as string[],
  readWebAuthState: vi.fn(async () => "linked" as const),
}));

vi.mock("./auth-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-state.js")>()),
  readWebAuthState: runtimeLoads.readWebAuthState,
}));

// mock-isolation: Observe preload ordering without initializing the socket/auth runtime.
vi.mock("./auth-store.js", () => {
  runtimeLoads.order.push("auth-store");
  return {};
});

vi.mock("./channel.runtime.js", () => {
  runtimeLoads.order.push("channel-runtime");
  return { monitorWebChannel: vi.fn() };
});

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function listChannelRuntimeImportOwners(): string[] {
  const owners: string[] = [];
  for (const relativePath of listDirectoryTreeStrictSync(sourceDir).map(
    (walkEntry) => walkEntry.relativePath,
  )) {
    if (!relativePath.endsWith(".ts") || relativePath.includes(".test")) {
      continue;
    }
    const filePath = path.join(sourceDir, relativePath);
    const sourceFile = parser.parseSourceFile(filePath, readFileSync(filePath, "utf8"));
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) && argument.text.endsWith("channel.runtime.js"),
        )
      ) {
        owners.push(relativePath);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return owners.toSorted();
}

describe("WhatsApp channel runtime loader", () => {
  it("reads auth without loading runtime and shares preloaded runtime imports", async () => {
    await expect(readWhatsAppAccountLinkState("/tmp/default")).resolves.toBe("linked");
    expect(runtimeLoads.order).toEqual([]);
    expect(runtimeLoads.readWebAuthState).toHaveBeenCalledExactlyOnceWith("/tmp/default");

    const firstRuntimeLoad = loadWhatsAppChannelRuntime();

    expect(loadWhatsAppChannelRuntime()).toBe(firstRuntimeLoad);
    await expect(firstRuntimeLoad).resolves.toEqual(expect.any(Object));
    expect(runtimeLoads.order).toEqual(["auth-store", "channel-runtime"]);
  });

  it("keeps one production owner for the channel runtime import", () => {
    expect(listChannelRuntimeImportOwners()).toEqual(["channel-runtime-loader.ts"]);
  });
});
