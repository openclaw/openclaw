from agent_tts.config import AgentTTSConfig, VoiceSettings


class VoiceResolver:
   def init(self, config: AgentTTSConfig):
       self._config = config

   def resolve(self, agent_id: str) -> VoiceSettings:
       defaults = self._config.defaults.model_dump()
       agent_cfg = self._config.agents.get(agent_id)
       if not agent_cfg:
           return self._config.defaults

       # Layer: defaults → group → agent
       merged = dict(defaults)

       if agent_cfg.group and agent_cfg.group in self._config.groups:
           group_overrides = self._config.groups[agent_cfg.group]
           merged.update({k: v for k, v in group_overrides.items() if v is not None})

       agent_overrides = agent_cfg.model_dump(exclude={"group"}, exclude_none=True)
       merged.update(agent_overrides)

       return VoiceSettings(**merged)

   def resolve_all(self) -> dict[str, VoiceSettings]:
       return {aid: self.resolve(aid) for aid in self._config.agents}