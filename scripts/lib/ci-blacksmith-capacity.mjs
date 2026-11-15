// Planner labels retain the pre-November 3 resource and timing profiles.
// Translate only at admission: Blacksmith now supplies the full requested size.
export const blacksmithRunnerLabel = (runner, minimumMemoryBytes = 0) => {
  const match = /^blacksmith-(4|8|16|32)vcpu-ubuntu-(2204|2404)$/.exec(runner ?? "");
  if (!match) {
    return undefined;
  }
  const originalCpus = Number(match[1]) >= 16 ? Number(match[1]) / 4 : 2;
  const cpus = [2, 4, 8, 16, 32].find(
    (size) => size >= originalCpus && size * 3.8 * 1024 ** 3 >= minimumMemoryBytes,
  );
  if (cpus === undefined) {
    throw new Error(`No Blacksmith runner satisfies ${minimumMemoryBytes} bytes`);
  }
  return `blacksmith-${cpus}vcpu-ubuntu-${match[2]}`;
};
