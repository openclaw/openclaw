import { readFileSync } from "node:fs";

export const QA_SMOKE_PROFILE_ID = "smoke-ci";

export const QA_SMOKE_PROFILE_CRABLINE_UNSUPPORTED_CATEGORY_IDS = [
  "channel-framework.channel-actions-commands-and-approvals",
];

function parseYamlScalar(value) {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.trim();
}

export function readTaxonomyProfileCategoryIds({
  taxonomyPath = "taxonomy.yaml",
  profileId = QA_SMOKE_PROFILE_ID,
} = {}) {
  const lines = readFileSync(taxonomyPath, "utf8").split(/\r?\n/u);
  const profilesStart = lines.findIndex((line) => line === "profiles:");
  if (profilesStart < 0) {
    throw new Error(`${taxonomyPath} does not define profiles.`);
  }

  let inTargetProfile = false;
  let inCategoryIds = false;
  const categoryIds = [];
  for (let index = profilesStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(" ")) {
      break;
    }

    const profileMatch = line.match(/^  - id:\s*(.+?)\s*$/u);
    if (profileMatch) {
      if (inTargetProfile) {
        break;
      }
      inTargetProfile = parseYamlScalar(profileMatch[1]) === profileId;
      inCategoryIds = false;
      continue;
    }

    if (!inTargetProfile) {
      continue;
    }
    if (/^    categoryIds:\s*$/u.test(line)) {
      inCategoryIds = true;
      continue;
    }
    if (!inCategoryIds) {
      continue;
    }

    const categoryMatch = line.match(/^      -\s*(.+?)\s*$/u);
    if (categoryMatch) {
      categoryIds.push(parseYamlScalar(categoryMatch[1]));
      continue;
    }
    if (/^ {0,5}\S/u.test(line)) {
      inCategoryIds = false;
    }
  }

  if (!inTargetProfile && categoryIds.length === 0) {
    throw new Error(`${taxonomyPath} does not define profile ${profileId}.`);
  }
  if (categoryIds.length === 0) {
    throw new Error(`${taxonomyPath} profile ${profileId} does not define categoryIds.`);
  }
  return categoryIds;
}

export function createQaSmokeProfileCategoryShards({
  taxonomyPath = "taxonomy.yaml",
  excludedCategoryIds = QA_SMOKE_PROFILE_CRABLINE_UNSUPPORTED_CATEGORY_IDS,
} = {}) {
  const excluded = new Set(excludedCategoryIds);
  return readTaxonomyProfileCategoryIds({ taxonomyPath }).flatMap((category) =>
    excluded.has(category)
      ? []
      : [
          {
            check_name: `checks-fast-qa-smoke-profile-${category}`,
            runtime: "node",
            task: "qa-smoke-profile",
            qa_category: category,
          },
        ],
  );
}
