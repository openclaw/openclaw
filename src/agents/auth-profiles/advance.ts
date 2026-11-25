export async function advanceAuthProfileCandidate<Candidate>(params: {
  candidates: readonly Candidate[];
  state: { profileIndex: number };
  isAvailable(profileId: Candidate, index: number): boolean;
  tryPrepare(profileId: Candidate, index: number): Promise<boolean>;
}): Promise<boolean> {
  for (const [index, candidate] of params.candidates.entries()) {
    if (index <= params.state.profileIndex) {
      continue;
    }
    // Exhaustion must not depend on credential-health bookkeeping succeeding.
    params.state.profileIndex = index;
    if (params.isAvailable(candidate, index) && (await params.tryPrepare(candidate, index))) {
      return true;
    }
  }
  params.state.profileIndex = params.candidates.length;
  return false;
}
