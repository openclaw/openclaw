/** A created page and the exact cleanup operation transferred to its adopting owner. */
export type PlaywrightOwnedPage = {
  targetId: string;
  title: string;
  url: string;
  type: string;
  close: () => Promise<void>;
  isCurrent: () => boolean;
};
