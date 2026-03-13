{{- if .Values.secret.create }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "openclaw.secretName" . }}
  labels:
    {{- include "openclaw.labels" . | nindent 4 }}
type: Opaque
stringData:
  OPENCLAW_GATEWAY_TOKEN: {{ required "secret.gatewayToken is required when secret.create=true" .Values.secret.gatewayToken | quote }}
  {{- with .Values.secret.providerKeys.anthropic }}
  ANTHROPIC_API_KEY: {{ . | quote }}
  {{- end }}
  {{- with .Values.secret.providerKeys.openai }}
  OPENAI_API_KEY: {{ . | quote }}
  {{- end }}
  {{- with .Values.secret.providerKeys.gemini }}
  GEMINI_API_KEY: {{ . | quote }}
  {{- end }}
  {{- with .Values.secret.providerKeys.openrouter }}
  OPENROUTER_API_KEY: {{ . | quote }}
  {{- end }}
{{- end }}
