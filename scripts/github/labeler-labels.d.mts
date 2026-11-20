type Repository = { owner: string; repo: string };
type NamedLabel = Repository & { name: string };
type IssueLabels = Repository & { issue_number: number; labels: string[] };

type LabelerGithub = {
  rest: {
    issues: {
      getLabel(params: NamedLabel): Promise<unknown>;
      createLabel(params: NamedLabel & { color: string }): Promise<unknown>;
      removeLabel(params: NamedLabel & { issue_number: number }): Promise<unknown>;
      addLabels(params: IssueLabels): Promise<unknown>;
    };
  };
};
type LabelOptions = Repository & {
  github: LabelerGithub;
  core: { warning(message: string): void };
  issueNumber: number;
  labels: string[];
};

export function addLabelsWithinCap(options: LabelOptions): Promise<boolean>;
export function ensureSizeLabels(
  options: Pick<LabelOptions, "github" | "owner" | "repo">,
): Promise<void>;
export function applySizeLabel(
  options: Omit<LabelOptions, "labels"> & {
    files: Array<{ filename?: string; additions?: number; deletions?: number }>;
    labelNames: Set<string>;
  },
): Promise<void>;
