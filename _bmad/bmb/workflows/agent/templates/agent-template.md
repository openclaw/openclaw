## {{#if comment}}

Agent Handlebars Template (Unified)
Used by: step-07-build-agent.md to generate final agent YAML
Documentation: ../data/agent-architecture.md

---

{{/if}}
agent:
metadata:
id: {{agent_id}}
name: {{agent_name}}
title: {{agent_title}}
icon: {{agent_icon}}
module: {{agent_module}}{{#if agent_module_comment}} {{!-- stand-alone, bmm, cis, bmgd, or other module --}}{{/if}}
hasSidecar: {{has_sidecar}}{{#if has_sidecar_comment}} {{!-- true if agent has a sidecar folder, false otherwise --}}{{/if}}
{{#if has_sidecar}}
sidecar-folder: {{sidecar_folder}}
sidecar-path: '{project-root}/\_bmad/\_memory/{{sidecar_folder}}/'
{{/if}}

persona:
role: |
{{persona_role}}{{#if persona_role_note}}
{{!-- 1-2 sentences, first person, what the agent does --}}{{/if}}

    identity: |
      {{persona_identity}}{{#if persona_identity_note}}
      {{!-- 2-5 sentences, first person, background/specializations --}}{{/if}}

    communication_style: |
      {{communication_style}}{{#if communication_style_note}}
      {{!-- How the agent speaks: tone, voice, mannerisms --}}
      {{#if has_sidecar}}
      {{!-- Include memory reference patterns: "Last time you mentioned..." or "I've noticed patterns..." --}}
      {{/if}}
      {{/if}}

    principles:
      {{#each principles}}
      - {{this}}
      {{/each}}

{{#if has_critical_actions}}
critical_actions:
{{#each critical_actions}} - '{{{this}}}'
{{/each}}
{{/if}}

{{#if has_prompts}}
prompts:
{{#each prompts}} - id: {{id}}
content: |
{{{content}}}
{{/each}}
{{/if}}

menu:
{{#each menu_items}} - trigger: {{trigger_code}} or fuzzy match on {{trigger_command}}
{{#if action_is_prompt}}
action: '#{{action_id}}'
{{else if action_updates_sidecar}}
action: {{{action_inline}}}
{{else}}
action: {{{action_inline}}}
{{/if}}
description: '[{{trigger_code}}] {{{description}}}'
{{/each}}

{{#if has_install_config}}
install_config:
compile_time_only: true
description: '{{install_description}}'
questions:
{{#each install_questions}} - var: {{var_name}}
prompt: '{{prompt}}'
type: {{question_type}}{{#if question_options}}
options:
{{#each question_options}} - label: '{{label}}'
value: '{{value}}'
{{/each}}
{{/if}}
default: {{{default_value}}}
{{/each}}
{{/if}}
