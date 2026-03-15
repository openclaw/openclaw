apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "openclaw.fullname" . }}-config
  labels:
    {{- include "openclaw.labels" . | nindent 4 }}
data:
  openclaw.json: |
{{ .Values.config.openclawJson | indent 4 }}
  AGENTS.md: |
{{ .Values.config.agentsMd | indent 4 }}
