apiVersion: v1
kind: Service
metadata:
  name: {{ include "openclaw.fullname" . }}
  labels:
    {{- include "openclaw.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "openclaw.selectorLabels" . | nindent 4 }}
  ports:
    - name: gateway
      port: {{ .Values.service.port }}
      targetPort: gateway
      protocol: TCP
