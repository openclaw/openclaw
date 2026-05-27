#!/usr/bin/env node

import { buildDiffsViewerRuntime } from "../../../scripts/build-diffs-viewer-runtime.mjs";

await buildDiffsViewerRuntime("full");
