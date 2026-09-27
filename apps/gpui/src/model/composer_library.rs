use serde::Deserialize;

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryEntry {
    pub skill_id: String,
    pub revision: String,
    pub slug: String,
    pub owner_label: String,
    pub description: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct LibrarySession {
    pub selections: Vec<LibraryEntry>,
    pub attachable: Vec<LibraryEntry>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryList {
    pub default_target: String,
    pub default_selection_limit: u32,
    pub default_selection_notice: Option<String>,
    pub session: Option<LibrarySession>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct LibraryFile {
    pub path: String,
    pub content: String,
    pub encoding: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct LibraryRead {
    pub entry: LibraryEntry,
    pub content: String,
    pub files: Vec<LibraryFile>,
}
