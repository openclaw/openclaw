/** Context file passed into embedded agents as preloaded workspace content. */
export type EmbeddedContextFile = {
  path: string;
  content: string;
  /** Preserved from authenticated bootstrap selection across workspace remapping. */
  personalUser?: true;
};
