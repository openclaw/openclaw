function buildTeamsFileInfoCard(file) {
  const rawETag = file.eTag;
  const uniqueId = rawETag.replace(/^["']|["']$/g, "").replace(/[{}]/g, "").split(",")[0] ?? rawETag;
  const lastDot = file.name.lastIndexOf(".");
  const fileType = lastDot >= 0 ? file.name.slice(lastDot + 1).toLowerCase() : "";
  return {
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: file.webDavUrl,
    name: file.name,
    content: {
      uniqueId,
      fileType
    }
  };
}
export {
  buildTeamsFileInfoCard
};
