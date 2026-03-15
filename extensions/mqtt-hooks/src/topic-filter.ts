export function matchesMqttTopicFilter(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");
  const topicRoot = topicLevels[0] ?? "";
  const filterRoot = filterLevels[0] ?? "";

  // Per MQTT spec §4.7.2, wildcard filters must not match $-prefixed system topics.
  if (topicRoot.startsWith("$") && (filterRoot === "#" || filterRoot === "+")) {
    return false;
  }

  for (let index = 0; index < filterLevels.length; index += 1) {
    const filterLevel = filterLevels[index];
    const topicLevel = topicLevels[index];

    if (filterLevel === "#") {
      return index === filterLevels.length - 1;
    }
    if (filterLevel === "+") {
      if (topicLevel === undefined) {
        return false;
      }
      continue;
    }
    if (topicLevel === undefined || filterLevel !== topicLevel) {
      return false;
    }
  }

  return topicLevels.length === filterLevels.length;
}
