export function renderFindingGroups<T extends { file: string }>(
  findings: T[],
  limit: number,
  renderFinding: (finding: T) => string,
): string[] {
  // Group before applying the cap so counts stay complete and files keep first-seen order.
  const grouped = new Map<string, T[]>();
  for (const finding of findings) {
    const fileFindings = grouped.get(finding.file);
    if (fileFindings) {
      fileFindings.push(finding);
    } else {
      grouped.set(finding.file, [finding]);
    }
  }

  const lines: string[] = [];
  let shown = 0;
  for (const [file, fileFindings] of grouped) {
    if (shown >= limit) {
      break;
    }
    lines.push(`- ${file} (${fileFindings.length})`);
    for (const finding of fileFindings) {
      if (shown >= limit) {
        break;
      }
      lines.push(renderFinding(finding));
      shown += 1;
    }
  }
  if (findings.length > shown) {
    lines.push(
      `... ${findings.length - shown} more finding(s) not shown; pass --limit 0 to show all.`,
    );
  }
  return lines;
}
