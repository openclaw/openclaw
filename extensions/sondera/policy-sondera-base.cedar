// ============================================
// SONDERA DEFAULT POLICY PACK FOR OPENCLAW
// ============================================
//
// Security rules providing baseline protection.
// All rule IDs prefixed with "sondera-" for clear identification.
// Rule count is dynamic - see logs for current count.
//
// Actions use: Sondera::Action::"<tool_name>"
// Context: context.params.<parameter> (PRE_TOOL)
//          context.response (POST_TOOL)
//
// NOTE: The default allow/block rule is injected programmatically
// based on the "Block All by Default" config setting.
//
// Learn more: https://docs.sondera.ai/writing-policies/
// ============================================


// ============================================
// DANGEROUS COMMAND RESTRICTIONS
// ============================================

// Block rm commands (file deletion)
@id("sondera-block-rm")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*rm *"
};

// Block recursive/force deletion flags (both -rf and -fr orderings)
@id("sondera-block-rf-flags")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (
    context.params.command like "*-rf*" ||
    context.params.command like "*-fr*"
  )
};

// Block sudo commands (privilege escalation)
@id("sondera-block-sudo")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*sudo *"
};

// Block su commands (switch user)
@id("sondera-block-su")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*su *"
};

// Block chmod 777 (world-writable permissions)
@id("sondera-block-chmod-777")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*chmod 777*"
};

// Block dangerous disk operations
@id("sondera-block-disk-operations")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*mkfs*" ||
   context.params.command like "*dd if=*" ||
   context.params.command like "*>/dev/sd*" ||
   context.params.command like "*>/dev/nvme*")
};

// Block kill/pkill of system processes
@id("sondera-block-kill-system")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*kill -9 1*" ||
   context.params.command like "*pkill -9 init*" ||
   context.params.command like "*killall*")
};

// Block shutdown/reboot commands
@id("sondera-block-shutdown")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*shutdown*" ||
   context.params.command like "*reboot*" ||
   context.params.command like "*poweroff*" ||
   context.params.command like "*init 0*")
};


// ============================================
// REMOTE CODE EXECUTION PREVENTION
// ============================================

// Block curl/wget piped to shell (remote script execution)
@id("sondera-block-curl-shell")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*curl*|*sh*" ||
   context.params.command like "*curl*|*bash*" ||
   context.params.command like "*wget*|*sh*" ||
   context.params.command like "*wget*|*bash*" ||
   context.params.command like "*curl*-o*&&*sh*" ||
   context.params.command like "*curl*-o*&&*bash*")
};

// Block base64 decode piped to shell (obfuscated execution)
@id("sondera-block-base64-shell")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*base64*-d*|*sh*" ||
   context.params.command like "*base64*-d*|*bash*" ||
   context.params.command like "*base64*--decode*|*sh*")
};

// Block netcat reverse shells
@id("sondera-block-netcat")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*nc *-e*" ||
   context.params.command like "*nc *-c*" ||
   context.params.command like "*netcat*-e*" ||
   context.params.command like "*ncat*-e*")
};

// Block data exfiltration via curl upload
@id("sondera-block-curl-upload")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*curl*--data*@*" ||
   context.params.command like "*curl*-d*@*" ||
   context.params.command like "*curl*-F*@*" ||
   context.params.command like "*curl*--upload-file*")
};


// ============================================
// SENSITIVE FILE RESTRICTIONS
// ============================================

// Block reading SSH keys
@id("sondera-block-read-ssh-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.ssh/id_*" ||
   context.params.path like "*/.ssh/authorized_keys*" ||
   context.params.path like "*.pem" ||
   context.params.path like "*.pk" ||
   context.params.path like "*.ppk")
};

// Block reading credential files
@id("sondera-block-read-credentials")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*credentials*" ||
   context.params.path like "*secrets*" ||
   context.params.path like "*.env" ||
   context.params.path like "*.env.*")
};

// Block reading AWS/cloud credentials
@id("sondera-block-read-cloud-creds")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.aws/*" ||
   context.params.path like "*/.gcloud/*" ||
   context.params.path like "*/.config/gcloud/*" ||
   context.params.path like "*/.azure/*" ||
   context.params.path like "*/.oci/*.pem" ||
   context.params.path like "*/.kube/config*")
};

// Block reading Docker credentials
@id("sondera-block-read-docker-creds")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  context.params.path like "*/.docker/config.json*"
};

// Block reading package manager tokens
@id("sondera-block-read-package-tokens")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.npmrc*" ||
   context.params.path like "*/.pypirc*" ||
   context.params.path like "*/pip.conf*")
};

// Block writing to SSH directory
@id("sondera-block-write-ssh")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  context.params.path like "*/.ssh/*"
};

// Block writing to env files
@id("sondera-block-write-env")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*.env" ||
   context.params.path like "*.env.*")
};

// Block writing to git internals
@id("sondera-block-write-git-internals")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  context.params.path like "*/.git/*"
};

// Block editing sensitive files
@id("sondera-block-edit-sensitive")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"edit" &&
  context has params && context.params has path &&
  (context.params.path like "*/.ssh/*" ||
   context.params.path like "*.env" ||
   context.params.path like "*.pem" ||
   context.params.path like "*credentials*")
};


// ============================================
// SYSTEM DIRECTORY RESTRICTIONS
// ============================================

// Block writing to system directories
@id("sondera-block-write-system-dirs")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "/etc/*" ||
   context.params.path like "/usr/*" ||
   context.params.path like "/bin/*" ||
   context.params.path like "/sbin/*" ||
   context.params.path like "/boot/*" ||
   context.params.path like "/run/*" ||
   context.params.path like "/sys/*" ||
   context.params.path like "/proc/*")
};

// Block globbing in sensitive directories
@id("sondera-block-glob-sensitive")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"glob" &&
  context has params && context.params has pattern &&
  (context.params.pattern like "*/.ssh/*" ||
   context.params.pattern like "*/.aws/*" ||
   context.params.pattern like "*/.gnupg/*")
};


// ============================================
// NETWORK RESTRICTIONS
// ============================================

// Block curl/wget to untrusted paste sites
@id("sondera-block-paste-sites")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*pastebin.com*" ||
   context.params.command like "*paste.ee*" ||
   context.params.command like "*hastebin*" ||
   context.params.command like "*0x0.st*")
};

// Block exfiltration via curl POST
@id("sondera-block-curl-post-external")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*curl*-X POST*" &&
  !(context.params.command like "*localhost*") &&
  !(context.params.command like "*127.0.0.1*")
};


// ============================================
// OUTPUT REDACTION (POST_TOOL)
// ============================================

// Redact API keys from tool output (generic patterns)
@id("sondera-redact-api-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*_API_KEY=*" ||
   context.response like "*_API_KEY\"*" ||
   context.response like "*API_KEY=*" ||
   context.response like "*APIKEY=*" ||
   context.response like "*api_key=*" ||
   context.response like "*apikey=*" ||
   context.response like "*api_key\":*" ||
   context.response like "*apiKey\":*")
};

// Redact secrets and tokens from tool output (generic patterns)
@id("sondera-redact-secrets")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*_SECRET=*" ||
   context.response like "*_SECRET\"*" ||
   context.response like "*SECRET=*" ||
   context.response like "*SECRET_KEY=*" ||
   context.response like "*_TOKEN=*" ||
   context.response like "*_TOKEN\"*" ||
   context.response like "*PASSWORD=*" ||
   context.response like "*PRIVATE_KEY=*" ||
   context.response like "*password\":*" ||
   context.response like "*secret\":*")
};

// Redact AWS credentials from tool output
@id("sondera-redact-aws-creds")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*AWS_ACCESS_KEY*" ||
   context.response like "*AWS_SECRET*" ||
   context.response like "*AKIA*")
};

// Redact GitHub tokens from tool output
@id("sondera-redact-github-tokens")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*ghp_*" ||
   context.response like "*gho_*" ||
   context.response like "*ghu_*" ||
   context.response like "*ghs_*" ||
   context.response like "*ghr_*" ||
   context.response like "*GITHUB_TOKEN*")
};

// Redact Slack tokens from tool output
@id("sondera-redact-slack-tokens")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*xoxb-*" ||
   context.response like "*xoxp-*" ||
   context.response like "*xoxa-*" ||
   context.response like "*xoxr-*")
};

// Redact database connection strings from tool output
@id("sondera-redact-db-conn-strings")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*postgres://*:*@*" ||
   context.response like "*mysql://*:*@*" ||
   context.response like "*mongodb://*:*@*" ||
   context.response like "*redis://*:*@*")
};

// Redact private keys from tool output
@id("sondera-redact-private-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*-----BEGIN*PRIVATE KEY-----*" ||
   context.response like "*-----BEGIN RSA PRIVATE*" ||
   context.response like "*-----BEGIN EC PRIVATE*" ||
   context.response like "*-----BEGIN OPENSSH PRIVATE*")
};

// Redact Anthropic API keys from tool output
@id("sondera-redact-anthropic-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*sk-ant-*" ||
   context.response like "*ANTHROPIC_API_KEY*")
};

// Redact HuggingFace tokens from tool output
@id("sondera-redact-huggingface-tokens")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*hf_*" ||
   context.response like "*HF_TOKEN*" ||
   context.response like "*HUGGINGFACE_*")
};

// Redact OpenAI API keys from tool output
@id("sondera-redact-openai-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*sk-proj-*" ||
   context.response like "*sk-svcacct-*" ||
   context.response like "*OPENAI_API_KEY*")
};

// Redact Stripe API keys from tool output
@id("sondera-redact-stripe-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*sk_live_*" ||
   context.response like "*sk_test_*" ||
   context.response like "*pk_live_*" ||
   context.response like "*pk_test_*" ||
   context.response like "*rk_live_*" ||
   context.response like "*rk_test_*")
};

// Redact Google API keys from tool output
@id("sondera-redact-google-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*AIza*" ||
   context.response like "*GOOGLE_API_KEY*" ||
   context.response like "*GOOGLE_APPLICATION_CREDENTIALS*")
};

// Redact SendGrid API keys from tool output
@id("sondera-redact-sendgrid-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  context.response like "*SG.*"
};

// Redact Twilio credentials from tool output
@id("sondera-redact-twilio-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*TWILIO_*" ||
   context.response like "*ACCOUNT_SID*")
};


// ============================================
// SHELL HISTORY PROTECTION
// ============================================

// Block reading shell history files (command history exfiltration)
@id("sondera-block-read-shell-history")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.bash_history" ||
   context.params.path like "*/.zsh_history" ||
   context.params.path like "*/.sh_history" ||
   context.params.path like "*/.history" ||
   context.params.path like "*/.node_repl_history" ||
   context.params.path like "*/.python_history" ||
   context.params.path like "*/.psql_history" ||
   context.params.path like "*/.mysql_history" ||
   context.params.path like "*/.rediscli_history")
};


// ============================================
// GUARDRAIL INTEGRITY
// ============================================

// Block modifying agent's own guardrails (self-modification protection)
@id("sondera-block-self-modify")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/extensions/sondera/*"
};
