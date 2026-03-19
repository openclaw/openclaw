import { z } from "zod";
import { buildChannelConfigSchema } from "../api.js";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());
