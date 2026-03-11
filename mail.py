# https://github.com/ram133/openclaw/mail.py
# Path: ~/Desktop/openclaw/mail.py
# Action: Reading local iMac system alerts

import os

def read_terminal_mail():
    mail_path = "/var/mail/cliffordhackett"
    if os.path.exists(mail_path):
        with open(mail_path, "r") as f:
            # Get the last 20 lines of system notifications
            alerts = f.readlines()[-20:]
            print("--- RECENT SYSTEM MAIL ---")
            print("".join(alerts))
    else:
        print("Action: Mail Check. Result: No local system mail found.")

if __name__ == "__main__":
    read_terminal_mail()
