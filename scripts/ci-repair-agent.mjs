#!/usr/bin/env node
// Native Node 24 launcher; the trusted publisher has no workspace dependencies.
import { main } from "./ci-repair-agent.mts";

await main(process.argv.slice(2));
