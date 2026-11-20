// Attribute descendants once an owner URL is reached, including native child frames.
// Count matching sample records independently of their recorded allocation size.
export function sampledOwnerBytes(profile, url) {
  const ids = new Set();
  function visit(node, inherited = false) {
    const owned = inherited || node.callFrame.url === url;
    if (owned) {
      ids.add(node.id);
    }
    return (
      (owned ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + visit(child, owned), 0)
    );
  }
  return {
    bytes: visit(profile.head),
    samples: profile.samples.filter((sample) => ids.has(sample.nodeId)).length,
  };
}
