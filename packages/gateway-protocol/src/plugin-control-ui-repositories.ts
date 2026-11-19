import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./schema/closed-object.js";
import { ProjectsSearchRemoteResultSchema } from "./schema/projects.js";

/** Metadata for a repository search contribution; discovery never executes browser code. */
export const ControlUiRepositorySourceSchema = closedObject({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" }),
  label: Type.String({ minLength: 1, maxLength: 100 }),
  searchMethod: Type.String({ minLength: 1, maxLength: 200 }),
});

export const ControlUiRepositorySearchResultSchema = ProjectsSearchRemoteResultSchema;

export type ControlUiRepositorySource = Static<typeof ControlUiRepositorySourceSchema>;
export type ControlUiRepositorySearchResult = Static<typeof ControlUiRepositorySearchResultSchema>;
