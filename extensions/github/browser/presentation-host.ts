/** Shared browser presentation primitives; GitHub owns all state-to-view decisions. */
export type GitHubPresentationHost = {
  t: (key: string, params?: Record<string, string>) => string;
  icons: Record<
    | "refresh"
    | "x"
    | "chevronDown"
    | "check"
    | "externalLink"
    | "alertTriangle"
    | "gitPullRequest"
    | "gitMerge"
    | "gitBranch",
    unknown
  >;
  syncDropdownItemRadio: (element: Element | undefined, selected: boolean) => void;
};
