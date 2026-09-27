use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Command {
    pub name: String,
    pub text_aliases: Vec<String>,
    pub description: String,
    pub category: String,
    pub accepts_args: bool,
    pub args: Vec<CommandArgument>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CommandArgument {
    pub name: String,
    pub required: bool,
}

impl Command {
    pub fn arg_hint(&self) -> String {
        self.args
            .iter()
            .map(|arg| {
                if arg.required {
                    format!("<{}>", arg.name)
                } else {
                    format!("[{}]", arg.name)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn matching<'a>(commands: &'a [Command], draft: &str) -> Vec<&'a Command> {
    let Some(query) = draft.strip_prefix('/') else {
        return Vec::new();
    };
    if query.contains(char::is_whitespace) {
        return Vec::new();
    }
    let query = query.to_lowercase();
    let mut matches: Vec<_> = commands
        .iter()
        .filter_map(|command| {
            let name = command.name.to_lowercase();
            let rank = if name == query {
                0
            } else if name.starts_with(&query) {
                1
            } else if command.text_aliases.iter().any(|alias| {
                alias
                    .trim_start_matches('/')
                    .to_lowercase()
                    .starts_with(&query)
            }) {
                2
            } else if name.contains(&query) || command.description.to_lowercase().contains(&query) {
                3
            } else {
                return None;
            };
            Some((rank, command))
        })
        .collect();
    matches.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    matches.into_iter().map(|(_, command)| command).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slash_search_ranks_names_before_aliases_and_descriptions_and_ignores_arguments() {
        let commands: Vec<Command> = serde_json::from_value(serde_json::json!([
            {"name":"usage","description":"View model usage"},
            {"name":"models"}, {"name":"model"},
            {"name":"choose","textAliases":["/model-picker"]}
        ]))
        .unwrap();
        assert_eq!(
            matching(&commands, "/model")
                .iter()
                .map(|command| command.name.as_str())
                .collect::<Vec<_>>(),
            ["model", "models", "choose", "usage"]
        );
        assert!(matching(&commands, "/model chosen").is_empty());
        assert!(matching(&commands, "hello /model").is_empty());
    }
}
