#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.env.MC_TEST_BASE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.MC_TEST_API_KEY || "";

type Team = {
  id: string;
  agentIds: string[];
};

type RequestOptions = RequestInit & {
  auth?: boolean;
};

async function request(route: string, init: RequestOptions = {}) {
  const headers = new Headers(init.headers || {});
  if (init.auth && apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  
  const response = await fetch(new URL(route, baseUrl), {
    ...init,
    headers,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { response, data };
}

console.log("Running TDD: Team Registry test...");

// Test: Fetching teams should return the solo-founder-team
const { response, data } = await request("/api/agents/teams", { auth: true });

if (response.status !== 200) {
  console.error(`FAILED: Expected 200, got ${response.status}`);
  process.exit(1);
}

const teams = Array.isArray(data) ? (data as Team[]) : [];
const soloFounder = teams.find((t) => t.id === "solo-founder-team");

if (!soloFounder) {
  console.error("FAILED: Could not find 'solo-founder-team' in response");
  process.exit(1);
}

if (soloFounder.agentIds.length < 3) {
  console.error("FAILED: 'solo-founder-team' should contain at least 3 agent IDs");
  process.exit(1);
}

console.log("PASSED: Team Registry test");
process.exit(0);
