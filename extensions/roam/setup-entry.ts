import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { roamPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(roamPlugin);
