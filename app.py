from flask import Flask, render_template, send_file
 import json
 import os
 from datetime import datetime
 app = Flask(__name__)
 REPORT_FILE = "backtest_report.json"
 CHART_FILE = "backtest_report.png"
 def load_report():
     if not os.path.exists(REPORT_FILE):
         return None
     with open(REPORT_FILE, encoding='utf-8') as f:
         return json.load(f)
 @app.route('/')
 def index():
     rep = load_report()
     now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
     if not rep:
         return render_template("no_report.html")
     total_ret = (rep['final_capital'] / rep['initial_capital']) - 1
     return render_template("report.html", report=rep, total_return=total_ret, update_time=now, now=now)
 @app.route('/image')
 def chart():
     return send_file(CHART_FILE, mimetype='image/png')
 if __name__ == "__main__":
     app.run(host="0.0.0.0", port=8080, debug=False)
