import type { Static } from "typebox";
import type { LobsterCatalogEntry } from "../lobsterdex.js";
import { closedObject } from "./closed-object.js";

export const LobsterdexCatalogParamsSchema = closedObject({});
export type LobsterdexCatalogParams = Static<typeof LobsterdexCatalogParamsSchema>;
export type LobsterdexCatalogResult = { entries: LobsterCatalogEntry[] };
