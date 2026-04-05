import { defineSetupPluginEntry } from "mullusi/plugin-sdk/core";
import { mattermostPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(mattermostPlugin);
