export function resolveEffortLevel(requested: string, available: string[]): string {
  const EFFORT_HIERARCHY = ['low', 'medium', 'high', 'max', 'ultra'];
  const reqLower = requested.toLowerCase();
  
  if (available.includes(reqLower)) {
    return reqLower;
  }
  
  const reqIndex = EFFORT_HIERARCHY.indexOf(reqLower);
  
  if (reqIndex !== -1) {
    for (let i = reqIndex; i >= 0; i--) {
      const fallbackLevel = EFFORT_HIERARCHY[i];
      if (available.includes(fallbackLevel)) {
        return fallbackLevel;
      }
    }
  }

  return available[0] || 'low';
}