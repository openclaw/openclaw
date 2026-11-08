/** Context file passed into embedded agents as preloaded workspace content. */
export type EmbeddedContextFile = {
  path: string;
  content: string;
  /** Preserved from authenticated bootstrap selection across workspace remapping. */
  personalUser?: true;
  /** Marked by the bootstrap loader when the file was absent and generated as a missing marker. */
  missing?: true;
};
