{{/*
Expand the name of the chart.
*/}}
{{- define "openclaw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openclaw.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "openclaw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "openclaw.labels" -}}
helm.sh/chart: {{ include "openclaw.chart" . }}
{{ include "openclaw.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "openclaw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openclaw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "openclaw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openclaw.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name (managed or existing).
*/}}
{{- define "openclaw.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "openclaw.fullname" . }}
{{- end }}
{{- end }}

{{/*
GCP credentials Secret name (managed or existing).
*/}}
{{- define "openclaw.gcpSecretName" -}}
{{- if .Values.vertexAI.credentials.create -}}
{{ include "openclaw.fullname" . }}-gcp-credentials
{{- else if .Values.vertexAI.existingSecret -}}
{{ .Values.vertexAI.existingSecret }}
{{- else -}}
{{- fail "vertexAI.enabled requires either vertexAI.credentials.create=true or vertexAI.existingSecret to be set" -}}
{{- end -}}
{{- end }}

{{/*
PVC name (managed or existing).
*/}}
{{- define "openclaw.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- include "openclaw.fullname" . }}
{{- end }}
{{- end }}
