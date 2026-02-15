use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Serialize, Deserialize, Debug)]
pub enum DateType {
    Birthday,
    Commemoration,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DateReminder {
    #[serde(default)]
    pub id: Option<String>,
    pub user_id: String,
    pub name: String,
    pub date_type: DateType,
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
    #[serde(default)]
    pub is_leap: bool,
    #[serde(default)]
    pub is_lunar: bool,
    #[serde(default)]
    pub is_male: bool,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}
