#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { validateNexusTaskPacket } from "../src/shared/nexus-task-packet.js";

function main(): number {
  const target = process.argv[2];
  if (!target) {
    console.error(
      "Usage: node --import tsx scripts/validate-nexus-task-packet.ts <packet.{yaml,yml,json}>",
    );
    return 1;
  }

  try {
    const raw = readFileSync(target, "utf8");
    const packet = validateNexusTaskPacket(raw);
    console.log(`valid Nexus task packet: ${packet.packet_id}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`invalid Nexus task packet: ${message}`);
    return 1;
  }
}

process.exit(main());
