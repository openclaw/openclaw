import mysql from "mysql2/promise";

const conn = await mysql.createConnection({
  host: "123.57.81.67",
  port: 3306,
  user: "btclaw_reader",
  password: "pd5])6K*(dcDZm(m",
  database: "superworker",
});

try {
  // Check topic 624
  const [r1] = await conn.execute(
    "SELECT COUNT(*) as cnt FROM feed_monitor_item WHERE topicId = 624",
  );
  console.log("topicId 624 in feed_monitor_item:", JSON.stringify(r1));

  const [r2] = await conn.execute(
    "SELECT COUNT(*) as cnt FROM feed_monitor_item WHERE slaveTopicId = 624",
  );
  console.log("slaveTopicId 624:", JSON.stringify(r2));

  // Also check what the latest 10 items look like for topic 585
  const [r3] = await conn.execute(`
    SELECT f.id, f.topicId, f.emotion, f.level, f.platform, f.date, f.link, 
           d.title, d.label, d.keywords, d.summary
    FROM feed_monitor_item f 
    LEFT JOIN feed_monitor_item_data d ON f.id = d.id 
    WHERE f.topicId = 585 
    ORDER BY f.date DESC
    LIMIT 10
  `);
  console.log("\n=== Topic 585 items ===");
  r3.forEach((r) => {
    console.log(
      JSON.stringify({
        id: r.id,
        title: (r.title || "").substring(0, 120),
        emotion: r.emotion,
        level: r.level,
        platform: r.platform,
        date: r.date,
        link: r.link,
        label: r.label,
      }),
    );
  });
} catch (e) {
  console.log("Error:", e.message);
} finally {
  await conn.end();
}
