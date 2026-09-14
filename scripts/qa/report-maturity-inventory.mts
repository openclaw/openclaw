#!/usr/bin/env node
import {
  collectAppMaturityInventory,
  collectChannelMaturityInventory,
  collectProviderMaturityInventory,
  type MaturityInventoryProjection,
} from "./maturity-inventory.mts";

function mappedCount(projection: MaturityInventoryProjection): number {
  return [...projection.membersBySurface.values()].reduce(
    (count, members) => count + members.length,
    0,
  );
}

function renderProjection(name: string, projection: MaturityInventoryProjection): string[] {
  const lines = [
    `${name}: ${mappedCount(projection)} mapped, ${projection.unmapped.length} unmapped, ${projection.ignored.length} support-only`,
  ];
  for (const member of projection.unmapped) {
    lines.push(`warning: ${name} inventory item ${member.id} has no maturity surface mapping`);
  }
  return lines;
}

const repoRoot = process.cwd();
const lines = [
  "Maturity inventory projection",
  ...renderProjection("channels", collectChannelMaturityInventory(repoRoot)),
  ...renderProjection("providers", collectProviderMaturityInventory(repoRoot)),
  ...renderProjection("apps", collectAppMaturityInventory(repoRoot)),
];
process.stdout.write(`${lines.join("\n")}\n`);
