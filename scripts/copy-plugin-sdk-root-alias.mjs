#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("src/plugin-sdk/root-alias.cjs");
const target = resolve("dist/plugin-sdk/root-alias.cjs");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
