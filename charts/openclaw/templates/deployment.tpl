apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "openclaw.fullname" . }}
  labels:
    {{- include "openclaw.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "openclaw.selectorLabels" . | nindent 6 }}
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        {{- include "openclaw.selectorLabels" . | nindent 8 }}
    spec:
      automountServiceAccountToken: false
      securityContext:
        fsGroup: {{ .Values.securityContext.fsGroup }}
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        - name: init-config
          image: {{ .Values.initContainer.image }}
          imagePullPolicy: {{ .Values.initContainer.pullPolicy }}
          command:
            - sh
            - -c
            - |
              cp /config/openclaw.json /home/node/.openclaw/openclaw.json
              mkdir -p /home/node/.openclaw/workspace
              cp /config/AGENTS.md /home/node/.openclaw/workspace/AGENTS.md
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
          resources:
            {{- toYaml .Values.initContainer.resources | nindent 12 }}
          volumeMounts:
            - name: openclaw-home
              mountPath: /home/node/.openclaw
            - name: config
              mountPath: /config
      containers:
        - name: gateway
          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          command:
            - node
            - /app/dist/index.js
            - gateway
            - run
          ports:
            - name: gateway
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          env:
            - name: HOME
              value: /home/node
            - name: OPENCLAW_CONFIG_DIR
              value: /home/node/.openclaw
            - name: NODE_ENV
              value: {{ .Values.nodeEnv | quote }}
            - name: OPENCLAW_GATEWAY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ include "openclaw.secretName" . }}
                  key: OPENCLAW_GATEWAY_TOKEN
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ include "openclaw.secretName" . }}
                  key: ANTHROPIC_API_KEY
                  optional: true
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ include "openclaw.secretName" . }}
                  key: OPENAI_API_KEY
                  optional: true
            - name: GEMINI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ include "openclaw.secretName" . }}
                  key: GEMINI_API_KEY
                  optional: true
            - name: OPENROUTER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ include "openclaw.secretName" . }}
                  key: OPENROUTER_API_KEY
                  optional: true
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          livenessProbe:
            exec:
              command:
                - node
                - -e
                - "require('http').get('http://127.0.0.1:{{ .Values.service.port }}/healthz', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"
            initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.liveness.periodSeconds }}
            timeoutSeconds: {{ .Values.probes.liveness.timeoutSeconds }}
            failureThreshold: {{ .Values.probes.liveness.failureThreshold }}
          readinessProbe:
            exec:
              command:
                - node
                - -e
                - "require('http').get('http://127.0.0.1:{{ .Values.service.port }}/readyz', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"
            initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.readiness.periodSeconds }}
            timeoutSeconds: {{ .Values.probes.readiness.timeoutSeconds }}
            failureThreshold: {{ .Values.probes.readiness.failureThreshold }}
          volumeMounts:
            - name: openclaw-home
              mountPath: /home/node/.openclaw
            - name: tmp-volume
              mountPath: /tmp
          securityContext:
            {{- toYaml .Values.containerSecurityContext | nindent 12 }}
      volumes:
        - name: openclaw-home
          {{- if .Values.persistence.enabled }}
          persistentVolumeClaim:
            claimName: {{ include "openclaw.fullname" . }}-home-pvc
          {{- else }}
          emptyDir: {}
          {{- end }}
        - name: config
          configMap:
            name: {{ include "openclaw.fullname" . }}-config
        - name: tmp-volume
          emptyDir: {}
