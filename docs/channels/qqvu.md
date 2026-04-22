# QQvu

## 快速开始
 > Support OpenClaw 2026.4.15 / OpenClaw 2026.4.20. Run `openclaw -v` to check and use `openclaw update` to upgrade
 
<Steps>
    <step title="Configure the plugin">
        ```bash
            openclaw plugins install @qqvu/openclaw-channel
        ```
    </step>
    <step title="Configure robots in openclaw.json">
        Need to create a robot on the QQvu app now, directory: my --> Robot --> Create Robot, 
        Copy the `UID` and `privateKey` of the robot, and replace the 【private key】 in the UID and 
        privateKey of the following tags.
        Here are examples of multiple robots.
        ```bash
                "pufferfish": {
                  "bots":{
                    "UID": {
                      "privateKey": "-----BEGIN PRIVATE KEY-----\n【private key】\n-----END PRIVATE KEY-----\n",
                      "enabled":true
                    },
                    "UID2": {
                      "privateKey": "-----BEGIN PRIVATE KEY-----\n【private key】\n-----END PRIVATE KEY-----\n",
                      "enabled":true
                    }
                  },
                  "botProfilesByBotUid": {
                    "UID": {
                      "systemPrompt": "",
                      "skills": []
                    }
                    "UID2": {
                      "systemPrompt": "",
                      "skills": []
                    }
                  }
                }
              },
        ```
        Before adding to `plugins` attribute
        ----------------------------------------------------------------------
        Add `skipBootsstrap` and `startupContext` to the agents tag
        ```bash
            {
              "agents": {
                "defaults": {
                  "skipBootstrap": true,  // 👈增加
                  "startupContext": {   // 👈增加
                    "enabled": false
                  }
                }
              }
            }
        ```
    </step>
    <step>
        Enter the. openclaw/workspace and delete the BOOTSTRAP.md file
    </step> 
    <step title="Start OpenClaw">
        Execute `openclaw gateway start`
    </step>
    <step title="Uninstalling plugins">
        ···bash
            openclaw plugins uninstall pufferfish-channel
        ```
    </step>
</Steps>