import { buildMediaPayload } from "openclaw/plugin-sdk/msteams";
function buildMSTeamsMediaPayload(mediaList) {
  return buildMediaPayload(mediaList, { preserveMediaTypeCardinality: true });
}
export {
  buildMSTeamsMediaPayload
};
