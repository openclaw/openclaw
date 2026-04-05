import { defineSetupPluginEntry } from "mullusi/plugin-sdk/core";
import { nostrPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(nostrPlugin);
